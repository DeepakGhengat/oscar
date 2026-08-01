# Start the proxy, then launch the claude CLI pointing at it.
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")

# Load .env into this PowerShell session (so USE_OPENAI_API etc. are
# visible to the launch logic below). Explicit env vars already set in
# the shell win over .env values — we only set ones that are unset.
$EnvFile = Join-Path $Root ".env"
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -le 0) { return }
    $key = $line.Substring(0, $idx).Trim()
    $val = $line.Substring($idx + 1).Trim()
    # strip surrounding quotes
    if ($val.Length -ge 2 -and (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'")))) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    if (-not [Environment]::GetEnvironmentVariable($key, "Process")) {
      [Environment]::SetEnvironmentVariable($key, $val, "Process")
    }
  }
}

$Port = if ($env:PROXY_PORT) { $env:PROXY_PORT } else { "8787" }

# Run the interactive setup wizard on first run or when --setup is passed.
$SetupFlag = $false
foreach ($arg in $args) { if ($arg -eq "--setup") { $SetupFlag = $true } }
$EnvFile = Join-Path $Root ".env"
if (-not (Test-Path $EnvFile) -or $SetupFlag) {
  Write-Host "Running setup wizard ..."
  $SetupTs = Join-Path $Root "src\setup.ts"
  $TsxCli = Join-Path $Root "node_modules\tsx\dist\cli.mjs"
  & node $TsxCli $SetupTs
  if ($LASTEXITCODE -ne 0) { Write-Host "Wizard exited with code $LASTEXITCODE, continuing." }
}

# Locate the claude CLI.
$ClaudeBin = ""
$Exe1 = Join-Path $Root "sdk\bin\claude.exe"
if (Test-Path $Exe1) {
  $ClaudeBin = $Exe1
} else {
  $Cmd = Get-Command claude -ErrorAction SilentlyContinue
  if ($Cmd) { $ClaudeBin = $Cmd.Source }
  else {
    Write-Error "claude CLI not found. Install it or run scripts/install-sdk.sh"
    exit 1
  }
}

# Validate required env when OpenAI routing is on.
if ($env:USE_OPENAI_API -eq "1") {
  if (-not $env:OPENAI_API_KEY) { Write-Error "OPENAI_API_KEY is required when USE_OPENAI_API=1"; exit 1 }
  if (-not $env:OPENAI_MODEL)   { Write-Error "OPENAI_MODEL is required when USE_OPENAI_API=1"; exit 1 }
}

# 1. Start proxy in background, output streaming to this console.
Write-Host "Starting proxy on port $Port ..."
$TsxCli = Join-Path $Root "node_modules\tsx\dist\cli.mjs"
$ServerTs = Join-Path $Root "src\server.ts"
$Proxy = Start-Process -FilePath "node" -ArgumentList "`"$TsxCli`"", "`"$ServerTs`"" -PassThru -NoNewWindow

try {
  # 2. Wait for health (up to ~10s).
  $Healthy = $false
  for ($i = 0; $i -lt 40; $i++) {
    if ($Proxy.HasExited) { Write-Error "Proxy exited early with code $($Proxy.ExitCode)"; exit 1 }
    try {
      $null = Invoke-WebRequest -Uri "http://localhost:$Port/healthz" -UseBasicParsing -ErrorAction Stop
      $Healthy = $true; break
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (-not $Healthy) { Write-Error "Proxy did not become healthy on port $Port"; exit 1 }
  Write-Host "Proxy healthy on port $Port."

  # 3. Launch claude pointed at the proxy.
  $env:ANTHROPIC_BASE_URL = "http://localhost:$Port"
  $env:ANTHROPIC_REAL_BASE_URL = "https://api.anthropic.com"
  # When routing to an OpenAI-compatible backend, the proxy ignores the
  # incoming Anthropic key (it uses OPENAI_API_KEY from .env). Set a dummy
  # key so the claude CLI skips its OAuth login gate. In passthrough mode,
  # leave the real key alone (user must authenticate normally).
  if ($env:USE_OPENAI_API -eq "1") {
    $env:ANTHROPIC_API_KEY = "claude-code-free-dummy-key"
  }

  Write-Host "Launching: $ClaudeBin"
  & $ClaudeBin @args
  exit $LASTEXITCODE
} finally {
  if ($Proxy -and -not $Proxy.HasExited) {
    try { Stop-Process -Id $Proxy.Id -Force -ErrorAction Stop } catch {}
  }
}