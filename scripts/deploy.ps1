param(
  [string]$ServiceAccountJsonPath = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies..."
  npm install
}

Write-Host "Checking Cloudflare login..."
npx wrangler whoami
if ($LASTEXITCODE -ne 0) {
  Write-Host "Opening Cloudflare login..."
  npx wrangler login
}

if (-not $ServiceAccountJsonPath) {
  $ServiceAccountJsonPath = Read-Host "Paste the full path to your Google service-account JSON file, or press Enter to skip secret upload"
}

if ($ServiceAccountJsonPath) {
  $ResolvedPath = Resolve-Path -LiteralPath $ServiceAccountJsonPath
  Write-Host "Uploading VERTEX_SERVICE_ACCOUNT_JSON secret..."
  Get-Content -Raw -LiteralPath $ResolvedPath | npx wrangler secret put VERTEX_SERVICE_ACCOUNT_JSON
}

Write-Host "Deploying Worker..."
npx wrangler deploy

Write-Host ""
Write-Host "Done. Use the deployed Worker URL as your API base URL, ending with /v1."
