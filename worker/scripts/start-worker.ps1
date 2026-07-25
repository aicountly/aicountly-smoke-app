# Start the smoke Playwright worker (Windows).
# Requires worker/.env with WORKER_SHARED_TOKEN matching backend WORKER_SHARED_TOKEN.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $here '..')

if (-not (Test-Path '.env')) {
  Write-Host 'Missing worker/.env — copy .env.example and set WORKER_SHARED_TOKEN.' -ForegroundColor Red
  exit 1
}

if (-not (Test-Path 'node_modules')) {
  npm install
}

if (-not (Test-Path 'dist/index.js')) {
  Write-Host 'Missing dist/index.js — run npm run worker:build from the repo root.' -ForegroundColor Red
  exit 1
}

Write-Host 'Starting smoke worker poll loop (Ctrl+C to stop)...' -ForegroundColor Cyan
npm run observe
