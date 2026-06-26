$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies..."
  npm install
}

npm run bundle
Write-Host ""
Write-Host "Bundled Worker written to:"
Write-Host (Resolve-Path ".\dist\worker.js")
