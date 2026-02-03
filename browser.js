const fs = require("fs");
const path = require("path");

const { loadConfig } = require("./config");
const { spawnWithStdin, runPythonCommand } = require("./utils");

function isHttpUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

function createBrowser({ DATA_DIR } = {}) {
    async function browseWebsite(
        {
            url,
            task,
            max_steps = 25,
            headless = true,
            use_vision = false,
            llm_provider = "openai",
            llm_model,
            temperature,
            base_url,
            chrome_executable_path,
            chrome_user_data_dir,
            screenshot = false,
            full_page = true,
            caption
        } = {},
        ctx
    ) {
        const chatId = ctx?.chatId;
        const safeSendMessage = ctx?.safeSendMessage;
        const safeSendPhoto = ctx?.safeSendPhoto;
        const sendLongMessage = ctx?.sendLongMessage;

        if (!url || !isHttpUrl(url)) {
            return { success: false, error: "Invalid URL. Only http/https URLs are allowed.", output: "" };
        }

        function isBrowserDisconnectedError(text) {
            const s = (text || "").toString().toLowerCase();
            return (
                s.includes("browser not connected") ||
                s.includes("no browser is open") ||
                s.includes("failed to open new tab") ||
                s.includes("cannot navigate - browser not connected") ||
                s.includes("agent focus target") && s.includes("detached") ||
                s.includes("target detached") ||
                s.includes("received duplicate response for request")
            );
        }

        const startedAt = Date.now();
        try {
            const runnerPath = path.join(process.cwd(), "browser_use_runner.py");
            const outputDir = path.join(DATA_DIR, "browser_use");
            await fs.promises.mkdir(outputDir, { recursive: true });

            const agentTask = (task && task.trim())
                ? `${task.trim()}\n\nStart URL: ${url}`
                : `Go to ${url} and summarize what you see. If it's a video page, summarize the title/description and any visible metadata.`;

            const requestedProvider = (llm_provider || "").toString().trim().toLowerCase();
            let effectiveProvider = "";
            if (requestedProvider === "openai" && process.env.OPENAI_API_KEY) effectiveProvider = "openai";
            else if (requestedProvider === "anthropic" && process.env.ANTHROPIC_API_KEY) effectiveProvider = "anthropic";
            else if (process.env.OPENAI_API_KEY) effectiveProvider = "openai";
            else if (process.env.ANTHROPIC_API_KEY) effectiveProvider = "anthropic";
            else return { success: false, error: "No LLM API key set for browser-use (set OPENAI_API_KEY or ANTHROPIC_API_KEY).", output: "" };

            const payload = {
                task: agentTask,
                llm_provider: effectiveProvider,
                llm_model: llm_model || undefined,
                temperature: Number.isFinite(temperature) ? temperature : undefined,
                base_url: base_url || undefined,
                max_steps: Math.max(1, Math.min(200, Math.floor(max_steps))),
                headless: Boolean(headless),
                use_vision: Boolean(use_vision),
                executable_path: chrome_executable_path || (loadConfig().chromePath || "").trim() || undefined,
                user_data_dir: chrome_user_data_dir || (loadConfig().chromeUserData || "").trim() || undefined,
                screenshot: Boolean(screenshot),
                screenshot_full_page: Boolean(full_page),
                output_dir: outputDir
            };

            const py = (loadConfig().browserUsePython || "python").toString().trim();
            const pyEnv = {
                ...process.env,
                // Ensure Python uses UTF-8 for stdin/stdout on Windows
                PYTHONUTF8: "1",
                PYTHONIOENCODING: "utf-8"
            };

            async function ensureBrowserUseReady() {
                const c = loadConfig();
                const autoInstall = c.autoInstallBrowserUse !== false;
                const ensurePlaywright = c.autoInstallPlaywright !== false;
                const ensureChromium = c.autoInstallPlaywrightChromium !== false;

                // Quick import checks
                const check = await runPythonCommand(py, ["-c", "import browser_use; print('ok')"], { timeoutMs: 30000, env: pyEnv });
                if (check.exitCode === 0) return true;
                if (!autoInstall) return false;

                if (safeSendMessage && chatId) {
                    await safeSendMessage(chatId, "Installing browser-use dependencies (python)... this may take a minute.");
                }

                // Install browser-use (and Playwright, which browser-use relies on for local browsing)
                try {
                    await runPythonCommand(py, ["-m", "pip", "install", "-U", "browser-use"], { timeoutMs: 10 * 60 * 1000, env: pyEnv });
                } catch (_) {}

                if (ensurePlaywright) {
                    try {
                        await runPythonCommand(py, ["-m", "pip", "install", "-U", "playwright"], { timeoutMs: 10 * 60 * 1000, env: pyEnv });
                    } catch (_) {}
                }

                if (ensureChromium) {
                    try {
                        await runPythonCommand(py, ["-m", "playwright", "install", "chromium"], { timeoutMs: 10 * 60 * 1000, env: pyEnv });
                    } catch (_) {}
                }

                const recheck = await runPythonCommand(py, ["-c", "import browser_use; print('ok')"], { timeoutMs: 30000, env: pyEnv });
                return recheck.exitCode === 0;
            }

            async function runRunnerOnce() {
                return await spawnWithStdin(
                    py,
                    [runnerPath],
                    JSON.stringify(payload),
                    { timeoutMs: 10 * 60 * 1000, env: pyEnv }
                );
            }

            let { stdout, stderr } = await runRunnerOnce();

            let result;
            try {
                result = JSON.parse((stdout || "").trim() || "{}");
            } catch (_) {
                result = { success: false, error: "Failed to parse browser-use output.", raw: stdout, stderr };
            }

            // Self-heal missing python deps on new machines
            if (
                !result.success &&
                typeof result.error === "string" &&
                /no module named ['"]browser_use['"]/i.test(result.error)
            ) {
                const ok = await ensureBrowserUseReady();
                if (ok) {
                    ({ stdout, stderr } = await runRunnerOnce());
                    try {
                        result = JSON.parse((stdout || "").trim() || "{}");
                    } catch (_) {
                        result = { success: false, error: "Failed to parse browser-use output.", raw: stdout, stderr };
                    }
                }
            }

            // Self-heal transient Playwright/Chrome disconnects by retrying once with a fresh session.
            if (
                !result.success &&
                isBrowserDisconnectedError(
                    [
                        result.error,
                        result.errors,
                        result.raw,
                        stderr
                    ].filter(Boolean).join("\n\n")
                )
            ) {
                if (safeSendMessage && chatId) {
                    await safeSendMessage(chatId, "Browser-use lost connection to the browser. Retrying with a fresh session...");
                }
                // small backoff
                await new Promise((r) => setTimeout(r, 1200));
                ({ stdout, stderr } = await runRunnerOnce());
                try {
                    result = JSON.parse((stdout || "").trim() || "{}");
                } catch (_) {
                    result = { success: false, error: "Failed to parse browser-use output.", raw: stdout, stderr };
                }
            }

            if (!result.success) {
                const msg = (result.error || (typeof result.errors === "string" ? result.errors : "") || "browser-use failed").toString();
                const extra =
                    result.raw
                        ? `\n\n${String(result.raw).slice(0, 2000)}`
                        : (stderr ? `\n\n${String(stderr).slice(0, 2000)}` : "");
                if (sendLongMessage && chatId) await sendLongMessage(chatId, `Browser error: ${msg}${extra}`);
                return { success: false, error: msg, output: result.raw || stderr || "" };
            }

            const finalText = (result.final_result ?? "").toString().trim();
            if (finalText && sendLongMessage && chatId) {
                await sendLongMessage(chatId, finalText);
            }

            if (result.screenshot_path && screenshot) {
                try {
                    if (safeSendPhoto && chatId) {
                        await safeSendPhoto(chatId, result.screenshot_path, { caption: caption || `Screenshot: ${url}` });
                    }
                } catch (e) {
                    if (sendLongMessage && chatId) {
                        await sendLongMessage(chatId, `Failed to send screenshot: ${e?.message || String(e)}`);
                    }
                }
            }

            const elapsedMs = Date.now() - startedAt;
            return {
                success: true,
                url,
                final_result_chars: finalText.length,
                screenshot_sent: Boolean(screenshot && result.screenshot_path),
                elapsed_ms: elapsedMs
            };
        } catch (error) {
            return { success: false, error: error?.message || String(error), output: "" };
        }
    }

    return { browseWebsite };
}

module.exports = { createBrowser };
