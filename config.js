const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(process.cwd(), "config.json");
const EXAMPLE_PATH = path.join(process.cwd(), "config.example.json");

const DEFAULTS = {
    dataDir: "./data",
    notesPath: "notes/notes.txt",
    openaiVisionModel: "gpt-4.1-mini",
    openaiTranscribeModel: "gpt-4o-mini-transcribe",
    stepConfirm: true,
    maxAgentIterations: 25,
    dataRetentionHours: 24,
    dataCleanupIntervalMinutes: 60,
    deepThinking: false,
    thinkingBudgetTokens: 8000,
    stopAfterSuccessfulBrowse: true,
    ffmpegPath: "",
    autoInstallFfmpeg: true,
    browserUsePython: "python",
    chromePath: "",
    chromeUserData: "",
    autoInstallBrowserUse: true,
    autoInstallPlaywright: true,
    autoInstallPlaywrightChromium: true,
    browserUseLlmProvider: "openai",
    browserUseLlmModel: "gpt-4o",
    powershellExe: "",
    gitBashPath: ""
};

function loadConfig() {
    let raw = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        }
    } catch (e) {
        console.warn("[config] Could not load config.json:", e?.message || e);
    }
    return { ...DEFAULTS, ...raw };
}

module.exports = { loadConfig, CONFIG_PATH, EXAMPLE_PATH, DEFAULTS };
