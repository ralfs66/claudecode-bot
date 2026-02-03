const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { loadConfig } = require("./config");
const { execPromise } = require("./utils");

const tools = [
    {
        name: "execute_command",
        description:
            "Execute commands/scripts on the Windows machine and return stdout/stderr. " +
            "Use this tool to actually DO the work (cmd, PowerShell, python, node, etc) and report output back to the user. " +
            "Prefer cmd for normal commands. Use PowerShell when you need multiline scripting, Windows cmdlets, or better quoting. " +
            "Avoid opening GUI apps (like notepad) unless the user explicitly asks.",
        input_schema: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description:
                        "A single command line to run. If you need to run a multiline script, provide it via `script` instead (preferred)."
                },
                script: {
                    type: "string",
                    description:
                        "Optional multiline script content. The bot will write it to a temp file and execute it using the selected shell."
                },
                shell: {
                    type: "string",
                    description: "Which shell/interpreter to use: auto (default), cmd, powershell, or bash.",
                    enum: ["auto", "cmd", "powershell", "bash"],
                    default: "auto"
                },
                file_path: {
                    type: "string",
                    description:
                        "Optional path to save the script to (if `script` is provided). If omitted, a temp file is used."
                },
                timeout_ms: {
                    type: "number",
                    description: "Timeout in milliseconds (default 30000).",
                    default: 30000
                },
                cwd: {
                    type: "string",
                    description: "Optional working directory for the command."
                },
                use_powershell: {
                    type: "boolean",
                    description: "Whether to execute using PowerShell. If omitted, the bot will auto-detect based on the command contents.",
                    default: true
                }
            },
            required: []
        }
    },
    {
        name: "take_screenshot",
        description:
            "Capture a screenshot of the current Windows desktop and send it back to the user as an image. " +
            "Use this when the user asks for a screenshot or wants to see the current screen. " +
            "Default is full virtual screen (all monitors).",
        input_schema: {
            type: "object",
            properties: {
                caption: {
                    type: "string",
                    description: "Optional caption to include with the screenshot."
                },
                file_path: {
                    type: "string",
                    description:
                        "Optional path to save the screenshot PNG. If omitted, a temp file is used and deleted after sending."
                }
            },
            required: []
        }
    },
    {
        name: "capture_webcam_photo",
        description:
            "Capture a single photo frame from a local webcam and send it back to the user as an image. " +
            "Uses ffmpeg DirectShow capture on Windows.",
        input_schema: {
            type: "object",
            properties: {
                device_name: {
                    type: "string",
                    description:
                        "Optional webcam device name (DirectShow). If omitted, the bot will pick the first available camera."
                },
                width: {
                    type: "number",
                    description: "Optional capture width (e.g. 1920)."
                },
                height: {
                    type: "number",
                    description: "Optional capture height (e.g. 1080)."
                },
                fps: {
                    type: "number",
                    description: "Optional frame rate (e.g. 30)."
                },
                format: {
                    type: "string",
                    description: "Output image format.",
                    enum: ["jpg", "png"],
                    default: "jpg"
                },
                file_path: {
                    type: "string",
                    description:
                        "Optional output path (relative paths are saved under the data folder). If omitted, a temp file is used and deleted after sending."
                },
                caption: {
                    type: "string",
                    description: "Optional caption to include with the webcam photo."
                }
            },
            required: []
        }
    },
    {
        name: "browse_website",
        description:
            "Browse a website using browser-use (AI browser agent). Use this to open URLs and complete web tasks, " +
            "and optionally send a page screenshot back to the user. Only use http/https URLs.",
        input_schema: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "The URL to open (http/https)."
                },
                task: {
                    type: "string",
                    description:
                        "Optional task instructions for the browser agent. If omitted, the agent will just open the URL and summarize what it sees."
                },
                max_steps: {
                    type: "number",
                    description: "Maximum number of agent steps.",
                    default: 25
                },
                headless: {
                    type: "boolean",
                    description: "Run browser headlessly (no visible window).",
                    default: true
                },
                use_vision: {
                    type: "boolean",
                    description: "Enable vision mode for the agent (more expensive).",
                    default: false
                },
                llm_provider: {
                    type: "string",
                    description: "LLM provider for browser-use (openai or anthropic).",
                    enum: ["openai", "anthropic"],
                    default: "openai"
                },
                llm_model: {
                    type: "string",
                    description: "Model name for the chosen provider (e.g. gpt-4o, claude-3-5-sonnet-20240620)."
                },
                temperature: {
                    type: "number",
                    description: "LLM temperature (optional)."
                },
                chrome_executable_path: {
                    type: "string",
                    description:
                        "Optional Chrome/Chromium executable path for browser-use to launch (e.g. C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe)."
                },
                chrome_user_data_dir: {
                    type: "string",
                    description:
                        "Optional Chrome user data dir for a persistent logged-in profile (e.g. C:\\\\Users\\\\You\\\\AppData\\\\Local\\\\Google\\\\Chrome\\\\User Data)."
                },
                screenshot: {
                    type: "boolean",
                    description: "If true, take a screenshot and send it to the user.",
                    default: false
                },
                full_page: {
                    type: "boolean",
                    description: "If screenshot=true, capture full page.",
                    default: true
                },
                caption: {
                    type: "string",
                    description: "Optional caption to include with the screenshot."
                }
            },
            required: ["url"]
        }
    },
    {
        name: "run_healer",
        description:
            "Run the healer script to install/fix dependencies on this PC (Node, Python, browser-use, Playwright Chromium, ffmpeg) and update config.json with detected paths. " +
            "Use this when the user reports setup issues, migration to a new PC, white/blank screenshots, or when other tools failed with errors like missing Python module 'browser_use', Playwright/Chromium not found, or ffmpeg not found. " +
            "Do NOT run healer for unrelated errors (e.g. API keys, network). Takes 2–5 minutes.",
        input_schema: {
            type: "object",
            properties: {
                reason: {
                    type: "string",
                    description: "Optional short reason (e.g. 'browse_website failed with missing browser_use')."
                }
            },
            required: []
        }
    }
];

const HEALER_RAN_THIS_PROCESS = { ran: false };

function createTools({ DATA_DIR, TMP_DIR, browseWebsite, resolveFfmpegPath, isFfmpegAvailable } = {}) {
    function resolveDataPath(p) {
        if (!p) return null;
        const s = p.toString().trim();
        if (!s) return null;
        return path.isAbsolute(s) ? s : path.join(DATA_DIR, s);
    }

    function shouldUsePowerShell(command) {
        if (!command) return false;
        // Heuristics: PowerShell snippets often contain variables, cmdlets, pipelines, or newlines.
        return (
            command.includes("\n") ||
            /\$\w+/.test(command) ||
            /\b(Get|Set|New|Remove|Write|Select|Where|ForEach|Out|Format|Start)-\w+\b/.test(command) ||
            /\|\s*(Select|Where|ForEach|Out|Format)-\w+\b/.test(command)
        );
    }

    function toPowerShellEncodedCommand(script) {
        // PowerShell expects UTF-16LE bytes, base64 encoded.
        return Buffer.from(script, "utf16le").toString("base64");
    }

    function getPowerShellExe() {
        const c = loadConfig();
        if ((c.powershellExe || "").toString().trim()) return c.powershellExe.trim();
        const winPs = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        return fs.existsSync(winPs) ? winPs : "powershell.exe";
    }

    function getGitBashExe() {
        const c = loadConfig();
        if ((c.gitBashPath || "").toString().trim()) return c.gitBashPath.trim();
        const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
        return fs.existsSync(gitBash) ? gitBash : "bash.exe";
    }

    function _quoteCmdArg(s) {
        const v = (s ?? "").toString();
        if (!v) return v;
        return v.includes(" ") ? `"${v.replace(/"/g, '\\"')}"` : v;
    }

    function resolveChromeExe() {
        const envPath = (loadConfig().chromePath || "").toString().trim();
        if (envPath) {
            try {
                if (fs.existsSync(envPath)) return envPath;
            } catch (_) {}
        }
        const candidates = [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ];
        for (const c of candidates) {
            try {
                if (fs.existsSync(c)) return c;
            } catch (_) {}
        }
        // Fall back to PATH resolution (may not exist).
        return "chrome.exe";
    }

    function rewriteStartChrome(command) {
        const trimmed = (command ?? "").toString().trim();
        if (!trimmed) return { changed: false, command: trimmed, didTryChrome: false };

        // Already start "" with path to chrome.exe — route to spawn so we never pass to cmd (avoids "cannot find '\\'" dialog from quoting).
        if (/^start\s+""\s+.+chrome\.exe/i.test(trimmed) || (trimmed.startsWith("start ") && /["']?[A-Za-z]:\\[^"']*chrome\.exe/i.test(trimmed))) {
            return { changed: false, command: trimmed, didTryChrome: true };
        }

        // Common user/LLM pattern: `start chrome "https://..."`
        // If `chrome` isn't on PATH, this silently does nothing. Rewrite to a full chrome.exe path.
        let m = trimmed.match(/^start\s+chrome(?:\.exe)?\b(.*)$/i);
        if (m) {
            const rest = (m[1] || "").trim();
            const chromeExe = resolveChromeExe();
            return {
                changed: true,
                didTryChrome: true,
                command: `start "" ${_quoteCmdArg(chromeExe)}${rest ? ` ${rest}` : ""}`.trim()
            };
        }

        // Another common pattern: `start "" chrome "https://..."`
        m = trimmed.match(/^start\s+""\s+chrome(?:\.exe)?\b(.*)$/i);
        if (m) {
            const rest = (m[1] || "").trim();
            const chromeExe = resolveChromeExe();
            return {
                changed: true,
                didTryChrome: true,
                command: `start "" ${_quoteCmdArg(chromeExe)}${rest ? ` ${rest}` : ""}`.trim()
            };
        }

        // If they directly call chrome.exe without a full path, try rewriting that too.
        m = trimmed.match(/^chrome(?:\.exe)?\b(.*)$/i);
        if (m) {
            const rest = (m[1] || "").trim();
            const chromeExe = resolveChromeExe();
            // If chromeExe resolved to the literal "chrome.exe", don't change.
            if (chromeExe.toLowerCase() === "chrome.exe") {
                return { changed: false, command: trimmed, didTryChrome: true };
            }
            return {
                changed: true,
                didTryChrome: true,
                command: `${_quoteCmdArg(chromeExe)}${rest ? ` ${rest}` : ""}`.trim()
            };
        }

        return { changed: false, command: trimmed, didTryChrome: false };
    }

    async function verifyChromeRunning() {
        // Give Chrome a moment to spawn.
        await new Promise((r) => setTimeout(r, 900));
        try {
            const { stdout, stderr } = await execPromise('tasklist /fi "imagename eq chrome.exe" /fo table', {
                timeout: 8000,
                windowsHide: true,
                maxBuffer: 2 * 1024 * 1024
            });
            const out = (stdout || stderr || "").toString();
            const running = /chrome\.exe/i.test(out) && !/No tasks are running/i.test(out);
            return { running, output: out.trim() };
        } catch (e) {
            return { running: false, output: e?.message || String(e) };
        }
    }

    function extractFirstUrl(text) {
        const s = (text ?? "").toString();
        const m = s.match(/https?:\/\/\S+/i);
        return m ? m[0] : null;
    }

    async function tryLaunchChromeDetached(commandText) {
        const chromeExe = resolveChromeExe();
        const url = extractFirstUrl(commandText);
        try {
            const args = [];
            if (url) {
                // Best-effort: open in a new window. Autoplay may still be blocked by YouTube/browser settings.
                args.push("--new-window", "--autoplay-policy=no-user-gesture-required", url);
            } else {
                args.push("--new-window");
            }
            const child = spawn(chromeExe, args, {
                detached: true,
                windowsHide: false,
                stdio: "ignore"
            });
            child.unref();
        } catch (e) {
            return {
                success: false,
                error: `Failed to launch Chrome: ${e?.message || String(e)}`,
                output: ""
            };
        }

        const check = await verifyChromeRunning();
        if (!check.running) {
            return {
                success: false,
                error: "Chrome did not start (no chrome.exe process detected).",
                output: check.output ? `[tasklist]\n${check.output}` : ""
            };
        }
        return {
            success: true,
            output: `Chrome launch attempted${url ? `: ${url}` : ""}\n\n[tasklist]\n${check.output || ""}`.trim(),
        };
    }

    function isLikelyInvalidWindowsTarget(target) {
        const t = (target ?? "").toString().trim();
        // This specific invalid path triggers the Windows "cannot find '\\'" dialog.
        return t === "\\\\" || t === "\\";
    }

    function looksLikeUrl(maybeUrl) {
        const s = (maybeUrl ?? "").toString().trim();
        return /^https?:\/\/\S+$/i.test(s);
    }

    function stripLeadingSlashes(s) {
        return (s ?? "").toString().replace(/^[\\/]+/, "");
    }

    function normalizeCmdStart(command) {
        // Normalize common bad patterns that cause Windows GUI popups:
        // - start \\               -> invalid
        // - start \https://...     -> should be start "" "https://..."
        // - \https://...           -> likely user pasted a URL with a leading backslash
        const trimmed = (command ?? "").toString().trim();

        // Reject "start" with no real target (empty or only title). Windows then resolves to \\ and shows "cannot find '\\'" dialog.
        if (/^start\s*$/i.test(trimmed) || /^start\s+""\s*$/i.test(trimmed) || /^start\s+"[^"]*"\s*$/i.test(trimmed)) {
            return { action: "reject", reason: "Refusing to run 'start' with no target (would trigger 'Windows cannot find \\\\' dialog). Specify an app or URL." };
        }

        // If the entire command is a backslashed URL, refuse (no popup) with a hint.
        const stripped = stripLeadingSlashes(trimmed);
        if (stripped !== trimmed && looksLikeUrl(stripped)) {
            return {
                action: "reject",
                reason:
                    "Looks like a URL with a leading \\\\ or /. " +
                    "Use the URL without the leading slash, or ask the bot to browse it. " +
                    `Example: ${stripped}`
            };
        }

        // Rewrite: start \https://...  or start \\https://...  -> start "" "https://..."
        const m = trimmed.match(/^start(\s+""\s*)?\s+([\\/]+)(https?:\/\/\S+)\s*$/i);
        if (m) {
            return { action: "rewrite", command: `start "" "${m[3]}"` };
        }

        // Reject invalid UNC root-only targets that trigger a popup.
        if (/^start(\s+""\s*)?\s+\\\\\s*$/i.test(trimmed) || /^start(\s+""\s*)?\s+\\\s*$/i.test(trimmed)) {
            return { action: "reject", reason: "Refusing to run an invalid Windows target path (\\\\) that triggers a popup." };
        }

        // If someone tries to open a malformed UNC like "\\server" (missing share), reject.
        const unc = trimmed.match(/^start(\s+""\s*)?\s+(\\\\[^\\\s]+)\s*$/i);
        if (unc) {
            return {
                action: "reject",
                reason:
                    `Refusing to run a malformed UNC path (${unc[2]}). ` +
                    "UNC paths must be like \\\\server\\\\share\\\\..."
            };
        }

        return { action: "ok", command: trimmed };
    }

    function detectShell({ shell, command, script, use_powershell }) {
        if (shell && shell !== "auto") return shell;
        if (typeof use_powershell === "boolean") return use_powershell ? "powershell" : "cmd";
        if (script && shouldUsePowerShell(script)) return "powershell";
        if (command && shouldUsePowerShell(command)) return "powershell";
        return "cmd";
    }

    function pickScriptExtension(shell, script) {
        if (shell === "powershell") return ".ps1";
        if (shell === "bash") return ".sh";
        if (shell === "cmd") return ".cmd";
        // auto fallback
        if (script && shouldUsePowerShell(script)) return ".ps1";
        return ".cmd";
    }

    async function writeTempScriptFile(script, extension, preferredPath) {
        if (preferredPath) {
            const targetPath = path.isAbsolute(preferredPath)
                ? preferredPath
                : path.join(DATA_DIR, preferredPath);
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.promises.writeFile(targetPath, script, { encoding: "utf8" });
            return targetPath;
        }
        const dir = path.join(TMP_DIR, "scripts");
        await fs.promises.mkdir(dir, { recursive: true });
        const filePath = path.join(
            dir,
            `script-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`
        );
        await fs.promises.writeFile(filePath, script, { encoding: "utf8" });
        return filePath;
    }

    async function executeCommand({ command, script, shell = "auto", file_path, timeout_ms = 30000, cwd, use_powershell } = {}) {
        try {
            const effectiveShell = detectShell({ shell, command, script, use_powershell });

            const hasScript = typeof script === "string" && script.trim().length > 0;
            const hasCommand = typeof command === "string" && command.trim().length > 0;

            if (!hasScript && !hasCommand) {
                return { success: false, error: "No command/script provided.", output: "" };
            }

            let cmd;
            if (hasScript) {
                const ext = pickScriptExtension(effectiveShell, script);
                const scriptPath = await writeTempScriptFile(script, ext, file_path);

                if (effectiveShell === "powershell") {
                    const ps = getPowerShellExe();
                    cmd = `"${ps}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`;
                } else if (effectiveShell === "bash") {
                    const bash = getGitBashExe();
                    // Use bash to execute the file; keep it simple.
                    cmd = `"${bash}" -lc "bash '${scriptPath.replace(/\\/g, "/")}'"`;
                } else {
                    // cmd
                    cmd = `cmd.exe /d /s /c "${scriptPath}"`;
                }
            } else {
                // Prevent a common accidental Windows dialog ("Windows cannot find '\\'").
                // Usually triggered by "start \\\\" or similar invalid target.
                if (effectiveShell === "cmd") {
                    const chromeRewrite = rewriteStartChrome(command);
                    if (chromeRewrite.changed) command = chromeRewrite.command;

                    // If the user/agent is trying to open regular Chrome, prefer a detached spawn
                    // (avoids cmd `start` hanging under some service/hidden contexts).
                    if (chromeRewrite.didTryChrome) {
                        const res = await tryLaunchChromeDetached(command);
                        // Return immediately; don't run via cmd.exe.
                        return res;
                    }
                    // Also handle explicit chrome.exe GUI launches like:
                    // `"C:\Program Files\Google\Chrome\Application\chrome.exe" "https://..."`
                    // but avoid intercepting non-GUI commands like `chrome.exe --version`.
                    if (
                        /\bchrome\.exe\b/i.test((command ?? "").toString()) &&
                        (extractFirstUrl(command) || /\b--new-window\b/i.test((command ?? "").toString()) || /\b--app=/i.test((command ?? "").toString()))
                    ) {
                        const res = await tryLaunchChromeDetached(command);
                        return res;
                    }
                    const normalized = normalizeCmdStart(command);
                    if (normalized.action === "reject") {
                        return { success: false, error: normalized.reason, output: "" };
                    }
                    if (normalized.action === "rewrite") {
                        command = normalized.command;
                    }
                    const trimmed = (command ?? "").toString().trim();
                    if (isLikelyInvalidWindowsTarget(trimmed)) {
                        return { success: false, error: "Refusing to run an invalid Windows target path (\\\\).", output: "" };
                    }
                }

                if (effectiveShell === "powershell") {
                    const ps = getPowerShellExe();
                    cmd = `"${ps}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${toPowerShellEncodedCommand(command)}`;
                } else if (effectiveShell === "bash") {
                    const bash = getGitBashExe();
                    cmd = `"${bash}" -lc "${command.replace(/"/g, '\\"')}"`;
                } else {
                    // cmd: allow python/node/etc through PATH. Avoid passing bare "start" or start with empty target (Windows would show "cannot find '\\'").
                    const safeCmd = (command ?? "").toString().trim();
                    if (/^start\s*$/i.test(safeCmd) || /^start\s+""\s*$/i.test(safeCmd)) {
                        return { success: false, error: "Refusing to run 'start' with no target (would trigger Windows 'cannot find \\\\' dialog).", output: "" };
                    }
                    cmd = `cmd.exe /d /s /c "${command.replace(/"/g, '\\"')}"`;
                }
            }

            const { stdout, stderr } = await execPromise(cmd, {
                timeout: timeout_ms,
                windowsHide: true,
                maxBuffer: 10 * 1024 * 1024,
                cwd: cwd
                    ? (path.isAbsolute(cwd) ? cwd : path.resolve(cwd))
                    : DATA_DIR
            });
            const outText = (stdout || "").toString();
            const errText = (stderr || "").toString();

            // If the command was intended to open Chrome, don't guess: verify a chrome.exe process exists.
            const cmdText = (hasCommand ? (command ?? "").toString() : "").trim();
            const looksLikeChromeLaunch =
                effectiveShell === "cmd" &&
                (/^start\b/i.test(cmdText) || /^chrome(\.exe)?\b/i.test(cmdText)) &&
                /\bchrome(\.exe)?\b/i.test(cmdText);

            if (looksLikeChromeLaunch) {
                const check = await verifyChromeRunning();
                if (!check.running) {
                    return {
                        success: false,
                        error: "Chrome did not start (no chrome.exe process detected).",
                        output: [outText, errText, check.output ? `\n[tasklist]\n${check.output}` : ""].filter(Boolean).join("\n").trim()
                    };
                }
                return {
                    success: true,
                    output: [outText, errText, check.output ? `\n[tasklist]\n${check.output}` : ""].filter(Boolean).join("\n").trim() || "Chrome started.",
                    error: errText
                };
            }

            return {
                success: true,
                output: outText || errText || "Command executed successfully",
                error: errText
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                output: error.stdout || ""
            };
        }
    }

    async function takeScreenshot({ caption, file_path } = {}, ctx) {
        const chatId = ctx?.chatId;
        const safeSendPhoto = ctx?.safeSendPhoto;

        const keepFile = typeof file_path === "string" && file_path.trim().length > 0;
        const outPath = keepFile
            ? (path.isAbsolute(file_path) ? path.resolve(file_path) : path.join(DATA_DIR, file_path))
            : path.join(TMP_DIR, `telegram-screenshot-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);

        await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

        // Use Windows PowerShell + .NET to capture the full virtual screen (all monitors).
        const escapedOutPath = outPath.replace(/'/g, "''");
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$outPath = '${escapedOutPath}'
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()

Write-Output $outPath
`.trim();

        const execResult = await executeCommand({
            script: psScript,
            shell: "powershell",
            timeout_ms: 60000
        });

        if (!execResult.success) {
            return { success: false, error: execResult.error || "Screenshot failed", output: execResult.output || "" };
        }

        if (!fs.existsSync(outPath)) {
            return { success: false, error: "Screenshot file was not created.", output: execResult.output || "" };
        }

        try {
            const stat = await fs.promises.stat(outPath);
            if (safeSendPhoto && chatId) {
                await safeSendPhoto(chatId, outPath, {
                    caption: caption || `Screenshot (${stat.size} bytes)`
                });
            }
            return { success: true, file_path: outPath, size_bytes: stat.size };
        } finally {
            if (!keepFile) {
                try {
                    await fs.promises.unlink(outPath);
                } catch (_) {
                    // ignore cleanup failures
                }
            }
        }
    }

    async function listDshowVideoDevices() {
        if (typeof resolveFfmpegPath !== "function") return [];
        const ffmpegPath = await resolveFfmpegPath();
        if (!ffmpegPath) return [];

        // ffmpeg prints DirectShow device list to stderr.
        const exe = ffmpegPath === "ffmpeg" ? "ffmpeg" : `"${ffmpegPath}"`;
        const cmd = `${exe} -hide_banner -list_devices true -f dshow -i dummy`;
        try {
            const { stderr } = await execPromise(cmd, { timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
            const text = (stderr || "").toString();
            const lines = text.split(/\r?\n/);

            const devices = [];
            let inVideo = false;
            for (const line of lines) {
                if (/DirectShow video devices/i.test(line)) {
                    inVideo = true;
                    continue;
                }
                if (/DirectShow audio devices/i.test(line)) {
                    inVideo = false;
                    continue;
                }
                if (!inVideo) continue;
                const m = line.match(/"([^"]+)"/);
                if (m && m[1]) devices.push(m[1]);
            }
            // Unique preserve order
            return [...new Set(devices)];
        } catch (_) {
            return [];
        }
    }

    async function captureWebcamPhoto(
        { device_name, width, height, fps, format = "jpg", file_path, caption } = {},
        ctx
    ) {
        const chatId = ctx?.chatId;
        const safeSendPhoto = ctx?.safeSendPhoto;

        if (typeof isFfmpegAvailable !== "function" || typeof resolveFfmpegPath !== "function") {
            return { success: false, error: "ffmpeg helpers are not configured.", output: "" };
        }
        if (!(await isFfmpegAvailable())) {
            return { success: false, error: "ffmpeg is not available on PATH.", output: "" };
        }

        const ffmpegPath = await resolveFfmpegPath();
        if (!ffmpegPath) {
            return { success: false, error: "ffmpeg not found.", output: "" };
        }

        let device = (device_name || "").toString().trim();
        if (!device) {
            const devices = await listDshowVideoDevices();
            if (!devices.length) {
                return { success: false, error: "No webcam devices found via ffmpeg DirectShow.", output: "" };
            }
            device = devices[0];
        }

        const keepFile = typeof file_path === "string" && file_path.trim().length > 0;
        const ext = (format || "jpg").toLowerCase() === "png" ? "png" : "jpg";
        const outPath = keepFile
            ? resolveDataPath(file_path)
            : path.join(TMP_DIR, `webcam-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);

        await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

        const args = [
            "-hide_banner",
            "-y",
            "-f",
            "dshow",
            "-rtbufsize",
            "100M",
        ];

        if (fps && Number.isFinite(fps)) {
            args.push("-framerate", String(Math.max(1, Math.floor(fps))));
        }
        if (width && height && Number.isFinite(width) && Number.isFinite(height)) {
            args.push("-video_size", `${Math.floor(width)}x${Math.floor(height)}`);
        }

        args.push("-i", `video=${device}`);
        args.push("-frames:v", "1");

        // Better JPEG quality defaults
        if (ext === "jpg") {
            args.push("-q:v", "2");
        }

        args.push(outPath);

        const exe = ffmpegPath === "ffmpeg" ? "ffmpeg" : `"${ffmpegPath}"`;
        const cmd = `${exe} ${args.map(a => (a.includes(" ") ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}`;

        try {
            await execPromise(cmd, { timeout: 30000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, cwd: DATA_DIR });
        } catch (e) {
            return { success: false, error: `Webcam capture failed: ${e?.message || String(e)}`, output: "" };
        }

        try {
            if (safeSendPhoto && chatId) {
                await safeSendPhoto(chatId, outPath, {
                    caption: caption || `Webcam photo (${device})`
                });
            }
            return { success: true, device, file_path: outPath };
        } finally {
            if (!keepFile) {
                try { await fs.promises.unlink(outPath); } catch (_) {}
            }
        }
    }

    async function runHealer() {
        if (HEALER_RAN_THIS_PROCESS.ran) {
            return {
                success: true,
                skipped: true,
                note: "Healer already ran once this session. Run 'npm run heal' manually if you need to run it again.",
                output: ""
            };
        }
        const healPath = path.join(process.cwd(), "heal.ps1");
        if (!fs.existsSync(healPath)) {
            return { success: false, error: "heal.ps1 not found in project root.", output: "" };
        }
        const timeoutMs = 8 * 60 * 1000;
        return new Promise((resolve) => {
            const child = spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-File", healPath], {
                cwd: process.cwd(),
                windowsHide: false,
                stdio: ["ignore", "pipe", "pipe"]
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (d) => { stdout += d.toString(); });
            child.stderr.on("data", (d) => { stderr += d.toString(); });
            const timer = setTimeout(() => {
                try { child.kill(); } catch (_) {}
                HEALER_RAN_THIS_PROCESS.ran = true;
                resolve({
                    success: false,
                    error: "Healer timed out after 8 minutes.",
                    output: (stdout + "\n" + stderr).trim().slice(-4000)
                });
            }, timeoutMs);
            child.on("close", (code) => {
                clearTimeout(timer);
                HEALER_RAN_THIS_PROCESS.ran = true;
                const out = (stdout + "\n" + stderr).trim();
                resolve({
                    success: code === 0,
                    exitCode: code,
                    output: out.slice(-8000)
                });
            });
            child.on("error", (err) => {
                clearTimeout(timer);
                HEALER_RAN_THIS_PROCESS.ran = true;
                resolve({ success: false, error: err.message, output: (stdout + "\n" + stderr).trim() });
            });
        });
    }

    async function runTool(name, input, ctx) {
        if (name === "execute_command") return await executeCommand(input || {});
        if (name === "take_screenshot") return await takeScreenshot(input || {}, ctx);
        if (name === "capture_webcam_photo") return await captureWebcamPhoto(input || {}, ctx);
        if (name === "browse_website") {
            if (typeof browseWebsite !== "function") {
                return { success: false, error: "browse_website is not configured.", output: "" };
            }
            return await browseWebsite(input || {}, ctx);
        }
        if (name === "run_healer") return await runHealer();
        return { success: false, error: `Unknown tool: ${name}` };
    }

    return {
        tools,
        runTool,
        executeCommand,
        takeScreenshot,
        captureWebcamPhoto
    };
}

module.exports = { tools, createTools };
