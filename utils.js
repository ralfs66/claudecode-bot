const { exec, spawn } = require("child_process");
const util = require("util");

const execPromise = util.promisify(exec);

function spawnWithStdin(command, args, stdinText, { timeoutMs = 600000, cwd, env } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            windowsHide: true,
            cwd: cwd || undefined,
            env: env || process.env
        });

        let stdout = "";
        let stderr = "";
        let finished = false;

        const killTimer = setTimeout(() => {
            if (finished) return;
            try { child.kill(); } catch (_) {}
            reject(new Error(`Process timeout after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
        }, timeoutMs);

        child.stdout.on("data", (d) => { stdout += d.toString(); });
        child.stderr.on("data", (d) => { stderr += d.toString(); });

        child.on("error", (err) => {
            clearTimeout(killTimer);
            finished = true;
            reject(err);
        });

        child.on("close", (code) => {
            clearTimeout(killTimer);
            finished = true;
            resolve({ stdout, stderr, exitCode: code });
        });

        if (stdinText) {
            try {
                child.stdin.write(stdinText);
            } catch (_) {}
        }
        try { child.stdin.end(); } catch (_) {}
    });
}

function quoteExe(p) {
    const s = (p ?? "").toString();
    if (!s) return s;
    return s.includes(" ") ? `"${s.replace(/"/g, '\\"')}"` : s;
}

async function runPythonCommand(py, args, { timeoutMs = 5 * 60 * 1000, env } = {}) {
    return await spawnWithStdin(py, args, "", { timeoutMs, env });
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function sanitizeError(err) {
    const raw = (err && (err.stack || err.message || String(err))) ? (err.stack || err.message || String(err)) : String(err);
    // redact Telegram bot token in URLs: https://api.telegram.org/bot<token>/...
    return raw.replace(/https:\/\/api\.telegram\.org\/bot[^/]+/g, "https://api.telegram.org/bot<redacted>");
}

function isTransientNetworkError(err) {
    const code = err?.code || err?.cause?.code;
    const msg = `${err?.message || ""} ${err?.cause?.message || ""}`.toLowerCase();
    return (
        code === "ECONNRESET" ||
        code === "ENOTFOUND" ||
        code === "EAI_AGAIN" ||
        code === "ETIMEDOUT" ||
        code === "ECONNREFUSED" ||
        code === "EFATAL" ||
        msg.includes("econnreset") ||
        msg.includes("enotfound") ||
        msg.includes("etimedout") ||
        msg.includes("socket hang up")
    );
}

async function withRetries(fn, { retries = 5, baseDelayMs = 500, maxDelayMs = 15000 } = {}) {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            return await fn();
        } catch (e) {
            attempt += 1;
            if (!isTransientNetworkError(e) || attempt > retries) throw e;
            const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
            await sleep(delay);
        }
    }
}

function createTelegramHelpers(bot) {
    async function safeSendMessage(chatId, text, options) {
        try {
            await withRetries(() => bot.sendMessage(chatId, text, options), { retries: 4 });
            return true;
        } catch (e) {
            console.warn("[telegram_sendMessage_failed]", sanitizeError(e));
            return false;
        }
    }

    async function safeSendPhoto(chatId, photo, options) {
        try {
            await withRetries(() => bot.sendPhoto(chatId, photo, options), { retries: 4 });
            return true;
        } catch (e) {
            console.warn("[telegram_sendPhoto_failed]", sanitizeError(e));
            return false;
        }
    }

    async function safeSendDocument(chatId, doc, options) {
        try {
            await withRetries(() => bot.sendDocument(chatId, doc, options), { retries: 4 });
            return true;
        } catch (e) {
            console.warn("[telegram_sendDocument_failed]", sanitizeError(e));
            return false;
        }
    }

    function chunkString(str, maxLen) {
        const chunks = [];
        for (let i = 0; i < str.length; i += maxLen) chunks.push(str.slice(i, i + maxLen));
        return chunks;
    }

    async function sendLongMessage(chatId, text) {
        const safe = (text ?? "").toString();
        if (!safe.trim()) {
            await safeSendMessage(chatId, "(no output)");
            return;
        }
        // Telegram message limit is ~4096 chars; keep some buffer.
        const parts = chunkString(safe, 3500);
        for (const part of parts) {
            const ok = await safeSendMessage(chatId, part);
            if (!ok) break;
        }
    }

    return { safeSendMessage, safeSendPhoto, safeSendDocument, sendLongMessage };
}

function installProcessGuards() {
    // Prevent network blips from crashing the entire process.
    process.on("unhandledRejection", (reason) => {
        console.warn("[unhandledRejection]", sanitizeError(reason));
    });
    process.on("uncaughtException", (err) => {
        console.warn("[uncaughtException]", sanitizeError(err));
    });
}

module.exports = {
    execPromise,
    spawnWithStdin,
    quoteExe,
    runPythonCommand,
    sleep,
    sanitizeError,
    isTransientNetworkError,
    withRetries,
    createTelegramHelpers,
    installProcessGuards
};
