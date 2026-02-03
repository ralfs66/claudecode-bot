const fs = require("fs");
const path = require("path");

const { loadConfig } = require("./config");
const { execPromise } = require("./utils");

function guessImageMime(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".png") return "image/png";
    if (ext === ".webp") return "image/webp";
    if (ext === ".gif") return "image/gif";
    return "image/jpeg";
}

function createOpenAI({ TMP_DIR, OPENAI_VISION_MODEL, OPENAI_TRANSCRIBE_MODEL } = {}) {
    let openaiClientPromise = null;

    async function getOpenAIClient() {
        const key = process.env.OPENAI_API_KEY;
        if (!key) return null;
        if (!openaiClientPromise) {
            openaiClientPromise = import("openai").then((mod) => {
                const OpenAI = mod.default;
                return { client: new OpenAI({ apiKey: key }), toFile: mod.toFile };
            });
        }
        return await openaiClientPromise;
    }

    async function analyzeImageWithOpenAI(imagePath, promptText) {
        const openai = await getOpenAIClient();
        if (!openai) {
            return { success: false, error: "OPENAI_API_KEY is not set (image understanding disabled).", output: "" };
        }

        const base64Image = await fs.promises.readFile(imagePath, "base64");
        const mime = guessImageMime(imagePath);
        const prompt =
            (promptText && promptText.trim())
                ? `User message: ${promptText}\n\nAnalyze this image. Extract any readable text (OCR) and describe the scene.`
                : "Analyze this image. Extract any readable text (OCR) and describe the scene.";

        // Prefer Responses API (openai@6.x), but fall back to chat.completions if needed.
        if (openai.client?.responses?.create) {
            const response = await openai.client.responses.create({
                model: OPENAI_VISION_MODEL,
                input: [
                    {
                        role: "user",
                        content: [
                            { type: "input_text", text: prompt },
                            { type: "input_image", image_url: `data:${mime};base64,${base64Image}` }
                        ]
                    }
                ]
            });
            return { success: true, output: response.output_text || "" };
        }

        if (openai.client?.chat?.completions?.create) {
            const completion = await openai.client.chat.completions.create({
                model: OPENAI_VISION_MODEL,
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: prompt },
                            { type: "image_url", image_url: { url: `data:${mime};base64,${base64Image}` } }
                        ]
                    }
                ]
            });
            const text = completion?.choices?.[0]?.message?.content || "";
            return { success: true, output: text };
        }

        return { success: false, error: "OpenAI client does not support responses or chat.completions in this runtime.", output: "" };
    }

    let ffmpegAvailabilityPromise = null;
    let ffmpegResolvedPath = null;

    function _candidateFfmpegPaths() {
        const out = [];
        const cfgPath = (loadConfig().ffmpegPath || "").toString().trim();
        if (cfgPath) out.push(cfgPath);
        // Common install locations
        out.push("C:\\ffmpeg\\bin\\ffmpeg.exe");
        out.push("C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe");
        // PATH fallback (winget often adds an alias)
        out.push("ffmpeg");
        return out;
    }

    async function resolveFfmpegPath() {
        if (ffmpegResolvedPath) return ffmpegResolvedPath;

        for (const candidate of _candidateFfmpegPaths()) {
            // If candidate is a path, ensure it exists before trying.
            if (candidate !== "ffmpeg") {
                try {
                    if (!fs.existsSync(candidate)) continue;
                } catch (_) {
                    continue;
                }
            }
            try {
                const cmd = candidate === "ffmpeg" ? "ffmpeg -version" : `"${candidate}" -version`;
                await execPromise(cmd, { timeout: 8000, windowsHide: true });
                ffmpegResolvedPath = candidate;
                return ffmpegResolvedPath;
            } catch (_) {
                // try next
            }
        }
        return null;
    }

    async function refreshFfmpegAvailability() {
        // Reset cached promise so new installs are detected.
        ffmpegAvailabilityPromise = null;
        ffmpegResolvedPath = null;
        return await isFfmpegAvailable();
    }

    async function isFfmpegAvailable() {
        if (!ffmpegAvailabilityPromise) {
            ffmpegAvailabilityPromise = (async () => {
                const resolved = await resolveFfmpegPath();
                return Boolean(resolved);
            })();
        }
        return await ffmpegAvailabilityPromise;
    }

    async function ensureFfmpegAvailable() {
        if (await isFfmpegAvailable()) return true;
        const autoInstall = loadConfig().autoInstallFfmpeg !== false;
        if (!autoInstall) return false;

        // Best-effort install via WinGet (may fail if winget not present).
        try {
            await execPromise(
                "winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements",
                { timeout: 5 * 60 * 1000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
            );
        } catch (_) {
            // ignore install failures
        }

        // If installed to C:\ffmpeg\bin, add to this process PATH so subsequent calls work.
        try {
            const maybe = "C:\\ffmpeg\\bin";
            if (fs.existsSync(path.join(maybe, "ffmpeg.exe"))) {
                process.env.PATH = `${maybe};${process.env.PATH || ""}`;
            }
        } catch (_) {}

        return await refreshFfmpegAvailability();
    }

    async function convertAudioToMp3(inputPath) {
        const outDir = path.join(TMP_DIR, "audio");
        await fs.promises.mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, `audio-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
        const ffmpeg = await resolveFfmpegPath();
        if (!ffmpeg) {
            throw new Error("ffmpeg not found");
        }
        const cmd = ffmpeg === "ffmpeg"
            ? `ffmpeg -y -i "${inputPath}" "${outPath}"`
            : `"${ffmpeg}" -y -i "${inputPath}" "${outPath}"`;
        await execPromise(cmd, { timeout: 120000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
        return outPath;
    }

    async function transcribeAudioWithOpenAI(audioPath) {
        const openai = await getOpenAIClient();
        if (!openai) {
            return { success: false, error: "OPENAI_API_KEY is not set (voice transcription disabled).", output: "" };
        }

        let toTranscribe = audioPath;
        const ext = path.extname(audioPath).toLowerCase();
        // OpenAI STT supports: mp3, mp4, mpeg, mpga, m4a, wav, webm.
        const supported = new Set([".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm"]);
        const needsConvert = !supported.has(ext);

        if (needsConvert) {
            const ok = await ensureFfmpegAvailable();
            if (!ok) {
                return {
                    success: false,
                    error:
                        `Unsupported audio format ${ext || "(unknown)"}. ` +
                        "Install ffmpeg (or set FFMPEG_PATH) so I can convert to mp3 before transcription.",
                    output: ""
                };
            }
            try {
                toTranscribe = await convertAudioToMp3(audioPath);
            } catch (e) {
                return {
                    success: false,
                    error: `Failed to convert audio via ffmpeg: ${e?.message || String(e)}`,
                    output: ""
                };
            }
        }

        try {
            const transcription = await openai.client.audio.transcriptions.create({
                file: fs.createReadStream(toTranscribe),
                model: OPENAI_TRANSCRIBE_MODEL
            });
            const text = transcription?.text || "";
            return { success: true, output: text };
        } catch (e) {
            return { success: false, error: e?.message || String(e), output: "" };
        }
    }

    return {
        analyzeImageWithOpenAI,
        transcribeAudioWithOpenAI,
        // ffmpeg helpers (used by webcam tool and error hints)
        resolveFfmpegPath,
        isFfmpegAvailable,
        ensureFfmpegAvailable
    };
}

module.exports = { createOpenAI };
