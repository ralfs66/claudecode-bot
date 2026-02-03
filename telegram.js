const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const { createTelegramHelpers, sanitizeError, installProcessGuards } = require("./utils");
const { createOpenAI } = require("./openai");
const { createBrowser } = require("./browser");
const { createTools } = require("./tools");
const { loadConfig } = require("./config");

function startTelegramBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    // Support multiple users: AUTHORIZED_USER_IDS=id1,id2,... or single AUTHORIZED_USER_ID
    const authorizedUserIds = (() => {
        const ids = (process.env.AUTHORIZED_USER_IDS || "").toString().trim();
        if (ids) return ids.split(",").map((s) => s.trim()).filter(Boolean);
        const single = (process.env.AUTHORIZED_USER_ID || "").toString().trim();
        return single ? [single] : [];
    })();

    if (!token || !anthropicApiKey) {
        console.error("Missing required environment variables. Please check your .env file.");
        process.exit(1);
    }

    const cfg = loadConfig();
    const DATA_DIR = path.resolve(cfg.dataDir || path.join(process.cwd(), "data"));
    const TMP_DIR = path.join(DATA_DIR, "tmp");
    const NOTES_PATH = path.resolve(process.cwd(), (cfg.notesPath || "notes/notes.txt").toString().trim());

    const OPENAI_VISION_MODEL = cfg.openaiVisionModel || "gpt-4.1-mini";
    const OPENAI_TRANSCRIBE_MODEL = cfg.openaiTranscribeModel || "gpt-4o-mini-transcribe";

    const DATA_RETENTION_HOURS = Math.max(1, Math.floor(Number(cfg.dataRetentionHours)) || 24);
    const DATA_CLEANUP_INTERVAL_MINUTES = Math.max(5, Math.floor(Number(cfg.dataCleanupIntervalMinutes)) || 60);

    const STEP_CONFIRM = cfg.stepConfirm !== false;
    const MAX_AGENT_ITERATIONS = Math.max(1, Math.min(100, Math.floor(Number(cfg.maxAgentIterations)) || 25));
    const DEEP_THINKING = cfg.deepThinking === true;
    const THINKING_BUDGET_TOKENS = Math.floor(Number(cfg.thinkingBudgetTokens)) || 8000;
    const STOP_AFTER_SUCCESSFUL_BROWSE = cfg.stopAfterSuccessfulBrowse !== false;

    // Ensure data and notes directories exist.
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.mkdirSync(TMP_DIR, { recursive: true });
        fs.mkdirSync(path.dirname(NOTES_PATH), { recursive: true });
    } catch (e) {
        console.error("Failed to create data directories:", e);
        process.exit(1);
    }

    async function cleanupOldFilesInDataDir() {
        const cutoffMs = Date.now() - DATA_RETENTION_HOURS * 60 * 60 * 1000;
        let deleted = 0;
        let scanned = 0;

        async function walk(dir) {
            let entries;
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch (_) {
                return;
            }

            for (const ent of entries) {
                const fullPath = path.join(dir, ent.name);
                scanned += 1;

                // Never delete the data root directory itself.
                if (path.resolve(fullPath) === path.resolve(DATA_DIR)) continue;

                let st;
                try {
                    st = await fs.promises.lstat(fullPath);
                } catch (_) {
                    continue;
                }

                // Skip symlinks/junctions for safety.
                if (st.isSymbolicLink()) continue;

                if (st.isDirectory()) {
                    await walk(fullPath);
                    // Optionally remove empty directories if they are old-ish.
                    try {
                        const remaining = await fs.promises.readdir(fullPath);
                        if (remaining.length === 0 && st.mtimeMs < cutoffMs) {
                            await fs.promises.rmdir(fullPath);
                        }
                    } catch (_) {}
                    continue;
                }

                if (st.isFile() && st.mtimeMs < cutoffMs) {
                    // Guard: ensure we only delete inside DATA_DIR
                    const resolved = path.resolve(fullPath);
                    const root = path.resolve(DATA_DIR) + path.sep;
                    if (!resolved.startsWith(root)) continue;

                    try {
                        await fs.promises.unlink(fullPath);
                        deleted += 1;
                    } catch (_) {
                        // ignore delete failures
                    }
                }
            }
        }

        await walk(DATA_DIR);
        if (deleted > 0) {
            console.log(`[data_cleanup] deleted=${deleted} scanned=${scanned} retention_hours=${DATA_RETENTION_HOURS}`);
        }
    }

    const bot = new TelegramBot(token, { polling: true });
    const anthropic = new Anthropic({ apiKey: anthropicApiKey });

    const { safeSendMessage, safeSendPhoto, safeSendDocument, sendLongMessage } = createTelegramHelpers(bot);
    const ctxForChat = (chatId) => ({ chatId, safeSendMessage, safeSendPhoto, safeSendDocument, sendLongMessage });

    installProcessGuards();

    bot.on("polling_error", (err) => {
        // Network issues are expected; log and keep running.
        console.warn("[polling_error]", sanitizeError(err));
    });

    // Periodic cleanup of old files in ./data (best-effort).
    // Run once shortly after startup, then every interval.
    setTimeout(() => {
        cleanupOldFilesInDataDir().catch((e) => console.warn("[data_cleanup_error]", sanitizeError(e)));
    }, 15 * 1000);
    setInterval(() => {
        cleanupOldFilesInDataDir().catch((e) => console.warn("[data_cleanup_error]", sanitizeError(e)));
    }, DATA_CLEANUP_INTERVAL_MINUTES * 60 * 1000);

    // Simple in-memory per-chat history so Claude can resolve references like
    // "this file", "that folder", "in current dir", etc.
    // NOTE: This resets when the bot restarts.
    const chatHistory = new Map(); // chatId -> Array<{role, content}>
    const MAX_HISTORY_MESSAGES = 40;
    const lastAttachment = new Map(); // chatId -> { imagePath?: string, audioPath?: string }

    function trimHistory(messages) {
        if (!Array.isArray(messages)) return [];
        if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
        return messages.slice(messages.length - MAX_HISTORY_MESSAGES);
    }

    async function downloadTelegramFile(fileId, subdir) {
        const dir = path.join(TMP_DIR, "telegram", subdir);
        await fs.promises.mkdir(dir, { recursive: true });
        // node-telegram-bot-api returns a local file path.
        return await bot.downloadFile(fileId, dir);
    }

    const openai = createOpenAI({ TMP_DIR, OPENAI_VISION_MODEL, OPENAI_TRANSCRIBE_MODEL });
    const browser = createBrowser({ DATA_DIR });
    const toolApi = createTools({
        DATA_DIR,
        TMP_DIR,
        browseWebsite: (input, ctx) => browser.browseWebsite(input, ctx),
        resolveFfmpegPath: openai.resolveFfmpegPath,
        isFfmpegAvailable: openai.isFfmpegAvailable
    });

    async function processWithClaude(messages, chatId, options = {}) {
        try {
            const {
                allowTools = true,
                deepThinking = DEEP_THINKING,
                thinkingBudgetTokens = THINKING_BUDGET_TOKENS,
                stepConfirm = STEP_CONFIRM
            } = options;

            const system = `
You are controlling a Windows machine through tools: execute_command, take_screenshot, capture_webcam_photo, browse_website, run_healer.

Hard requirements:
- Always use execute_command to perform actions and verify results.
- Always return the real command output to the user (stdout/stderr).
- If output is empty but a result should exist, run a follow-up command to show it.
- Do NOT open GUI apps (notepad, explorer, etc.) unless the user explicitly asks.
- Prefer a single cmd command when possible. Use PowerShell only when you need multiline scripting/cmdlets/complex quoting.
- When you need a multiline script, pass it via the tool's "script" field (preferred).
- If the user asks for a screenshot or wants to "see the screen", use take_screenshot.
- If the user asks for a webcam/camera photo, use capture_webcam_photo.
- If the user asks to browse a website, open a link, scrape a page, or screenshot a page, use browse_website.
- When you see dependency/setup errors (missing browser_use, Playwright/Chromium, ffmpeg, or user says "migrated to new PC" / "screenshots are white"), use run_healer to fix dependencies and paths. Do not use run_healer for API or network errors.
- Only browse http/https URLs.
- If the user sends a URL (or text that obviously contains a URL), prefer browse_website unless they explicitly ask to open it in a GUI browser.
- When opening a URL in regular Chrome (GUI), use cmd and the correct Windows start syntax: start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --new-window "<url>".
- Never prefix URLs with backslashes (avoid commands like "\\\\https://..." or "\\https://...").
- Default working directory is the bot's data folder: ${DATA_DIR}
- If you create files without an explicit absolute path, create them in the data folder.
- Default file for bot notes and saved text: ${NOTES_PATH}. When the user asks to save a note, remember something, or store text for later, write to this file (append or overwrite as appropriate). Prefer this path for any persistent notes the user might refer to later.
- Track context: if the user says "this file" / "that file" / "current dir", infer the path from recent messages and tool outputs.
  If ambiguous, pick the most recently mentioned file/path and verify with a quick directory listing.

Step mode:
- When step-by-step mode is enabled, do at most ONE tool call per model turn (internal control).
- Do NOT ask the user "continue or stop" — decide internally whether to proceed with another step.
- Prefer to output at most ONE tool_use per assistant message.
`.trim();

            const convo = Array.isArray(messages) ? [...messages] : [];

            // Some Claude models support extended thinking via `thinking`.
            // If the API/model rejects it, we retry without thinking.
            const createParamsBase = {
                system,
                model: "claude-sonnet-4-5-20250929",
                max_tokens: 4096,
                tools: allowTools ? toolApi.tools : [],
                messages: convo
            };

            const createWithMaybeThinking = async () => {
                if (!deepThinking) return await anthropic.messages.create(createParamsBase);
                return await anthropic.messages.create({
                    ...createParamsBase,
                    thinking: { type: "enabled", budget_tokens: Math.max(1024, Math.min(32000, Math.floor(thinkingBudgetTokens))) }
                });
            };

            let response;
            try {
                response = await createWithMaybeThinking();
            } catch (e) {
                if (deepThinking) {
                    // Fallback for models/accounts that don't support `thinking`.
                    response = await anthropic.messages.create(createParamsBase);
                } else {
                    throw e;
                }
            }

            let iterations = 0;
            // Prevent duplicate browser actions (common when the model loops internally).
            // We only de-dupe high-impact actions like opening Chrome/URLs and browse_website.
            const executedBrowserActions = new Set(); // fingerprint -> true

            while (response.stop_reason === "tool_use") {
                iterations += 1;
                if (iterations > MAX_AGENT_ITERATIONS) {
                    break;
                }
                if (!allowTools) break;
                // Anthropic protocol requirement:
                // If a single assistant message contains multiple tool_use blocks,
                // the next user message MUST contain tool_result blocks for ALL tool_use ids.
                const toolUses = (response.content || []).filter(block => block.type === "tool_use");
                if (!toolUses.length) break;

                const toolResultsBlocks = [];
                let executedThisResponse = 0;
                let stopAfterBrowseSuccess = false;
                for (const toolUse of toolUses) {
                    // Step-by-step mode: execute at most one real tool call per assistant response.
                    const shouldExecute = !(stepConfirm && executedThisResponse >= 1);

                    const fingerprintBrowserAction = () => {
                        try {
                            if (toolUse.name === "browse_website") {
                                const u = (toolUse.input?.url || "").toString().trim();
                                const t = (toolUse.input?.task || "").toString().trim();
                                if (!u) return null;
                                return `browse:${u}|${t}`;
                            }
                            if (toolUse.name === "execute_command") {
                                const c = (toolUse.input?.command || "").toString().trim();
                                if (!c) return null;
                                // Dedup only URL/browser-launching commands (not normal commands like dir, python, etc.)
                                const isChrome = /\bchrome(\.exe)?\b/i.test(c);
                                const hasUrl = /https?:\/\/\S+/i.test(c);
                                const isStartUrl = /^start\b/i.test(c) && hasUrl;
                                const isChromeLaunch = isChrome && (hasUrl || /^start\b/i.test(c));
                                if (!isStartUrl && !isChromeLaunch) return null;
                                return `exec:${c}`;
                            }
                            return null;
                        } catch (_) {
                            return null;
                        }
                    };

                    let toolResult;
                    const fp = fingerprintBrowserAction();
                    if (!shouldExecute) {
                        toolResult = {
                            success: false,
                            deferred: true,
                            error: "Deferred by step-by-step mode. The agent should continue in a follow-up step.",
                        };
                    } else if (fp && executedBrowserActions.has(fp)) {
                        toolResult = {
                            success: true,
                            deduped: true,
                            note: "Skipped duplicate browser action (already executed in this request).",
                            fingerprint: fp
                        };
                    } else if (toolUse.name === "execute_command") {
                        const preview =
                            toolUse.input?.script
                                ? `[script:${toolUse.input.shell || "auto"}] ${(toolUse.input.file_path || "").toString()}`
                                : (toolUse.input?.command || "").toString();
                        await safeSendMessage(chatId, `Executing: ${preview || "(empty)"}`);
                        toolResult = await toolApi.runTool("execute_command", toolUse.input || {}, ctxForChat(chatId));
                        if (fp && toolResult && toolResult.success) executedBrowserActions.add(fp);
                        executedThisResponse += 1;
                    } else if (toolUse.name === "take_screenshot") {
                        await safeSendMessage(chatId, "Taking screenshot...");
                        toolResult = await toolApi.runTool("take_screenshot", toolUse.input || {}, ctxForChat(chatId));
                        executedThisResponse += 1;
                    } else if (toolUse.name === "capture_webcam_photo") {
                        await safeSendMessage(chatId, "Capturing webcam photo...");
                        toolResult = await toolApi.runTool("capture_webcam_photo", toolUse.input || {}, ctxForChat(chatId));
                        executedThisResponse += 1;
                    } else if (toolUse.name === "browse_website") {
                        await safeSendMessage(chatId, `Browsing: ${(toolUse.input?.url || "").toString()}`);
                        toolResult = await toolApi.runTool("browse_website", toolUse.input || {}, ctxForChat(chatId));
                        if (fp && toolResult && toolResult.success) executedBrowserActions.add(fp);
                        executedThisResponse += 1;
                        if (STOP_AFTER_SUCCESSFUL_BROWSE && toolResult && toolResult.success) {
                            // Important: browser-use can succeed, but the model may start another round and fail,
                            // overwriting the success. Stop immediately after the first successful browse.
                            stopAfterBrowseSuccess = true;
                        }
                    } else if (toolUse.name === "run_healer") {
                        await safeSendMessage(chatId, "Running healer (installing dependencies, updating paths — may take 2–5 min)...");
                        toolResult = await toolApi.runTool("run_healer", toolUse.input || {}, ctxForChat(chatId));
                        executedThisResponse += 1;
                    } else {
                        toolResult = {
                            success: false,
                            error: `Unknown tool: ${toolUse.name}`
                        };
                    }

                    toolResultsBlocks.push({
                        type: "tool_result",
                        tool_use_id: toolUse.id,
                        content: JSON.stringify(toolResult)
                    });
                }

                convo.push({ role: "assistant", content: response.content });
                convo.push({ role: "user", content: toolResultsBlocks });

                if (stopAfterBrowseSuccess) {
                    return {
                        replyText: "Browser task completed.",
                        updatedMessages: convo
                    };
                }

                const nextParams = { ...createParamsBase, messages: convo };
                try {
                    response = await (deepThinking
                        ? anthropic.messages.create({
                            ...nextParams,
                            thinking: { type: "enabled", budget_tokens: Math.max(1024, Math.min(32000, Math.floor(thinkingBudgetTokens))) }
                        })
                        : anthropic.messages.create(nextParams));
                } catch (_) {
                    response = await anthropic.messages.create(nextParams);
                }
            }

            // Persist the final assistant response into the conversation history too,
            // so follow-up messages can refer to it.
            convo.push({
                role: "assistant",
                content: response.content
            });

            let textContent = response.content
                .filter(block => block.type === "text")
                .map(block => block.text)
                .join("\n");

            // Hard-stop common "prompt the user to continue" phrases (should be internal only).
            textContent = textContent
                .split("\n")
                .filter(line => !/continue\s+or\s+stop\?/i.test(line))
                .filter(line => !/would you like me to (take|continue|proceed)/i.test(line))
                .join("\n")
                .trim();

            return {
                replyText: textContent || "Task completed.",
                updatedMessages: convo
            };
        } catch (error) {
            console.error("Claude API Error:", error);
            return {
                replyText: `Error: ${error.message}`,
                updatedMessages: Array.isArray(messages) ? messages : []
            };
        }
    }

    async function handleUserText(chatId, text) {
        // New request.
        const prior = chatHistory.get(chatId) || [];
        const next = [...prior, { role: "user", content: text }];
        const { replyText, updatedMessages } = await processWithClaude(trimHistory(next), chatId, {
            allowTools: true,
            deepThinking: DEEP_THINKING,
            thinkingBudgetTokens: THINKING_BUDGET_TOKENS,
            stepConfirm: STEP_CONFIRM
        });
        chatHistory.set(chatId, trimHistory(updatedMessages));
        await sendLongMessage(chatId, replyText);
    }

    async function handlePhotoMessage(chatId, caption, fileId) {
        try {
            await safeSendMessage(chatId, "Downloading image...");
            const imagePath = await downloadTelegramFile(fileId, "images");
            lastAttachment.set(chatId, { ...(lastAttachment.get(chatId) || {}), imagePath });

            await safeSendMessage(chatId, "Analyzing image...");
            const analysis = await openai.analyzeImageWithOpenAI(imagePath, caption || "");
            if (!analysis.success) {
                await sendLongMessage(chatId, `Image analysis unavailable: ${analysis.error}`);
                return;
            }

            const combined = [
                caption ? `User message: ${caption}` : null,
                `Image saved locally at: ${imagePath}`,
                `Image analysis (OCR + description):\n${analysis.output || "(empty)"}`
            ].filter(Boolean).join("\n\n");

            await handleUserText(chatId, combined);
        } catch (e) {
            await sendLongMessage(chatId, `Error processing image: ${e?.message || String(e)}`);
        }
    }

    async function handleVoiceMessage(chatId, fileId) {
        try {
            await safeSendMessage(chatId, "Downloading audio...");
            const audioPath = await downloadTelegramFile(fileId, "audio");
            lastAttachment.set(chatId, { ...(lastAttachment.get(chatId) || {}), audioPath });

            await safeSendMessage(chatId, "Transcribing audio...");
            const transcript = await openai.transcribeAudioWithOpenAI(audioPath);
            if (!transcript.success) {
                const ffmpegHint = (await openai.isFfmpegAvailable())
                    ? ""
                    : "\n\nTip: Telegram voice notes are usually .ogg/.oga; install ffmpeg and add it to PATH for best transcription reliability.";
                await sendLongMessage(chatId, `Transcription unavailable: ${transcript.error}${ffmpegHint}`);
                return;
            }

            const text = (transcript.output || "").trim();
            if (!text) {
                await safeSendMessage(chatId, "(Transcription was empty.)");
                return;
            }

            await sendLongMessage(chatId, `Heard:\n${text}`);
            await handleUserText(chatId, text);
        } catch (e) {
            await sendLongMessage(chatId, `Error processing audio: ${e?.message || String(e)}`);
        }
    }

    bot.on("message", async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const text = msg.text;
        const caption = msg.caption;

        if (authorizedUserIds.length > 0 && !authorizedUserIds.includes(userId)) {
            const username = msg.from.username ? `@${msg.from.username}` : "(no username)";
            const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || "(no name)";

            console.warn(
                `[UNAUTHORIZED] chatId=${chatId} userId=${userId} username=${username} name="${name}" text=${JSON.stringify(text || caption || "")}`
            );

            await safeSendMessage(
                chatId,
                `Unauthorized user.\n\nYour Telegram ID: ${userId}\nUsername: ${username}\nName: ${name}`
            );
            return;
        }

        try {
            if (text === "/start") {
                await safeSendMessage(
                    chatId,
                    "Hello! Send me natural-language instructions and I will run commands/scripts on this Windows machine and return output.\n\n" +
                    "You can also:\n" +
                    '- send "screenshot" to capture the desktop\n' +
                    "- send a URL and ask to browse/screenshot it\n" +
                    "- send a photo (optional OpenAI key) for image understanding\n" +
                    "- send a voice note (optional OpenAI key) for transcription\n\n" +
                    (STEP_CONFIRM
                        ? "Step-by-step mode is enabled (internal). The bot will take actions one-by-one with separate model calls.\n\n"
                        : "") +
                    'Examples:\n- "create file hello.txt with hello world"\n- "list running processes"\n- "open https://example.com and screenshot it"'
                );
                return;
            }

            if (typeof text === "string" && text.trim().length > 0) {
                await safeSendMessage(chatId, "Processing your request...");
                await handleUserText(chatId, text);
                return;
            }

            if (Array.isArray(msg.photo) && msg.photo.length > 0) {
                const best = msg.photo[msg.photo.length - 1];
                await handlePhotoMessage(chatId, caption || "", best.file_id);
                return;
            }

            if (msg.voice?.file_id) {
                await handleVoiceMessage(chatId, msg.voice.file_id);
                return;
            }

            if (msg.audio?.file_id) {
                await handleVoiceMessage(chatId, msg.audio.file_id);
                return;
            }

            // Optional: image sent as a document
            if (msg.document?.file_id && (msg.document.mime_type || "").startsWith("image/")) {
                await handlePhotoMessage(chatId, caption || "", msg.document.file_id);
                return;
            }

            await safeSendMessage(chatId, "Unsupported message type. Send text, a photo, or a voice note.");
        } catch (error) {
            console.error("Error:", error);
            await safeSendMessage(chatId, `Error: ${error.message}`);
        }
    });

    console.log("Bot is running...");
    console.log("Press Ctrl+C to stop.");
}

module.exports = { startTelegramBot };
