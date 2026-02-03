# Healer script: installs all dependencies so the bot works after migrating to a new PC.
# Run from the project root: .\heal.ps1   or   powershell -ExecutionPolicy Bypass -File .\heal.ps1

$ErrorActionPreference = "Continue"
$ProjectRoot = $PSScriptRoot
if (-not $ProjectRoot) { $ProjectRoot = Get-Location }
Set-Location $ProjectRoot

function Write-Step { param($Msg) Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Write-Ok    { param($Msg) Write-Host "    OK: $Msg" -ForegroundColor Green }
function Write-Warn  { param($Msg) Write-Host "    WARN: $Msg" -ForegroundColor Yellow }
function Write-Fail  { param($Msg) Write-Host "    FAIL: $Msg" -ForegroundColor Red }

Write-Host "`n--- ClaudeCode Bot Healer (new PC / migration) ---" -ForegroundColor Magenta

# ----- 1. Node.js -----
Write-Step "Checking Node.js..."
$nodeExe = $null
try {
    $nodeExe = Get-Command node -ErrorAction SilentlyContinue
} catch {}
if (-not $nodeExe) {
    Write-Fail "Node.js not found. Install from https://nodejs.org/ (LTS) and run this script again."
    Write-Host "    Or try: winget install OpenJS.NodeJS.LTS"
    exit 1
}
$nodeVer = & node -v 2>$null
Write-Ok "Node.js $nodeVer"

# ----- 2. npm install -----
Write-Step "Installing Node dependencies (npm install)..."
try {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install exited with $LASTEXITCODE" }
    Write-Ok "npm install done"
} catch {
    Write-Fail "npm install failed: $_"
}

# ----- 3. Python -----
Write-Step "Checking Python..."
$py = "python"
$pyExe = $null
$pythonPath = ""
foreach ($candidate in @("python", "python3", "py -3")) {
    try {
        $pyVer = & $candidate -c "import sys; print(sys.version)" 2>$null
        if ($pyVer) {
            $pyExe = $candidate
            try {
                $pythonPath = (Get-Command $candidate -ErrorAction SilentlyContinue).Source
                if (-not $pythonPath -and $candidate -eq "py -3") {
                    $pythonPath = (Get-Command "py" -ErrorAction SilentlyContinue).Source
                }
            } catch {}
            break
        }
    } catch {}
}
if (-not $pyExe) {
    Write-Fail "Python 3 not found. Install from https://www.python.org/ (check 'Add to PATH') and run this script again."
    Write-Host "    Or try: winget install Python.Python.3.12"
    exit 1
}
$pyVerOut = & $pyExe -c "import sys; print(sys.version)" 2>$null
Write-Ok "Python: $pyVerOut"
if ($pythonPath) { Write-Ok "  Path: $pythonPath" }

# ----- 4. browser-use + Playwright + Chromium -----
Write-Step "Installing browser-use and Playwright (for browse_website and screenshots)..."
$pyEnv = @{}
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

try {
    & $pyExe -m pip install -U pip 2>$null
    & $pyExe -m pip install -U browser-use 2>&1 | Out-Null
    Write-Ok "browser-use installed"
} catch { Write-Warn "browser-use install: $_" }

try {
    & $pyExe -m pip install -U playwright 2>&1 | Out-Null
    Write-Ok "playwright installed"
} catch { Write-Warn "playwright install: $_" }

Write-Step "Installing Playwright Chromium browser (required for browse_website and page screenshots)..."
try {
    & $pyExe -m playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "playwright install chromium exited with $LASTEXITCODE" }
    Write-Ok "Playwright Chromium installed"
} catch {
    Write-Fail "Playwright Chromium install failed. Page screenshots may be white/blank. Error: $_"
}

# Optional: install Chromium dependencies (on Linux this helps; on Windows often not needed)
try {
    & $pyExe -m playwright install-deps chromium 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Ok "Playwright system deps installed" }
} catch {}

# ----- 5. ffmpeg (voice transcription + webcam) -----
Write-Step "Checking ffmpeg (voice notes + webcam)..."
$ffmpegPath = ""
try {
    $ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($ff) { $ffmpegPath = $ff.Source }
} catch {}
if (-not $ffmpegPath) {
    if (Test-Path "C:\ffmpeg\bin\ffmpeg.exe") { $ffmpegPath = "C:\ffmpeg\bin\ffmpeg.exe" }
}
if (-not $ffmpegPath) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "    Installing ffmpeg via winget..."
        & winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
        $env:Path = "C:\ffmpeg\bin;$env:Path"
        if (Test-Path "C:\ffmpeg\bin\ffmpeg.exe") {
            $ffmpegPath = "C:\ffmpeg\bin\ffmpeg.exe"
            Write-Ok "ffmpeg installed (C:\ffmpeg\bin)"
        } else { Write-Warn "ffmpeg may need to be added to PATH manually" }
    } else {
        Write-Warn "ffmpeg not found. For voice transcription and webcam: install from https://ffmpeg.org/ and add to PATH; healer will set config when found."
    }
} else {
    Write-Ok "ffmpeg found: $ffmpegPath"
}

# ----- 6. config.json (non-secret settings + detected paths) -----
Write-Step "Ensuring config.json (paths and options)..."
$configPath = Join-Path $ProjectRoot "config.json"
$examplePath = Join-Path $ProjectRoot "config.example.json"
if (-not (Test-Path $configPath) -and (Test-Path $examplePath)) {
    Copy-Item $examplePath $configPath
    Write-Ok "config.json created from config.example.json"
}
$chromePath = ""
foreach ($p in @("C:\Program Files\Google\Chrome\Application\chrome.exe", "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe")) {
    if (Test-Path $p) { $chromePath = $p; break }
}
try {
    $config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pythonPath) { $config.browserUsePython = $pythonPath }
    elseif ($pyExe -and -not $config.browserUsePython) { $config.browserUsePython = $pyExe }
    if ($chromePath) { $config.chromePath = $chromePath }
    if ($ffmpegPath) { $config.ffmpegPath = $ffmpegPath }
    $config | ConvertTo-Json -Depth 2 | Set-Content $configPath -Encoding UTF8
    Write-Ok "config.json updated with detected paths (Python, Chrome, ffmpeg)"
} catch {
    Write-Warn "Could not update config.json: $_"
}

# ----- 7. .env (secrets only) -----
Write-Step "Checking .env (secrets only)..."
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Ok ".env created from .env.example — edit .env with your TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, etc."
    } else {
        Write-Warn "No .env or .env.example found. Create .env with TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY."
    }
} else {
    Write-Ok ".env exists"
}

# ----- 8. Quick sanity check -----
Write-Step "Quick sanity check..."
$sanityOk = $true
try {
    $null = node -e "require('dotenv').config(); require('./config'); require('./telegram'); require('./tools'); require('./browser');"
    Write-Ok "Node modules and bot files load OK"
} catch {
    Write-Warn "Sanity check failed: $_"
    $sanityOk = $false
}

# ----- Tips (especially for white screens) -----
Write-Host "`n--- Tips for avoiding white/blank screens on a new PC ---" -ForegroundColor Magenta
Write-Host @"

  • Desktop screenshots: Run the bot from an interactive session (not as a service).
  • Browse/page screenshots: Healer installed Playwright Chromium; paths are in config.json.
  • Paths (Python, Chrome, ffmpeg) are in config.json — healer fills them; edit there if needed.
  • Start the bot: npm start   (or node bot.js)

"@ -ForegroundColor Gray

Write-Host "Healer finished." -ForegroundColor Green
if (-not $sanityOk) { exit 1 }
exit 0
