[CmdletBinding()]
param(
  [string]$OutputDirectory = "release"
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$packagePath = Join-Path $repoRoot "package.json"
$package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  throw "package.json version is not a supported semantic version: $version"
}

$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
$expectedPrefix = $repoRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $releaseRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Release output must stay inside the repository: $releaseRoot"
}

$bundleName = "axiom-agent-control-room-v$version"
$stagingRoot = Join-Path $releaseRoot $bundleName
$zipPath = Join-Path $releaseRoot "$bundleName.zip"
$checksumPath = "$zipPath.sha256"

$requiredPaths = @(
  "dist",
  "server-dist",
  "package.json",
  "package-lock.json",
  ".env.example",
  "README.md",
  "README.zh-CN.md",
  "scripts/setup-local-provider-secret.mjs",
  "CHANGELOG.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "docker-compose.local.yml",
  "docs"
)

foreach ($relativePath in $requiredPaths) {
  $source = Join-Path $repoRoot $relativePath
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Required release input is missing: $relativePath"
  }
}

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
if (Test-Path -LiteralPath $checksumPath) { Remove-Item -LiteralPath $checksumPath -Force }
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

foreach ($relativePath in $requiredPaths) {
  $source = Join-Path $repoRoot $relativePath
  $destination = Join-Path $stagingRoot $relativePath
  if ((Get-Item -LiteralPath $source).PSIsContainer) {
    Copy-Item -LiteralPath $source -Destination $destination -Recurse
  } else {
    $parent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
  }
}

# Vite copies public/ into dist/. Local comparison demos are intentionally not
# part of a deployable runtime bundle even when an existing build contains them.
$bundledDemo = Join-Path $stagingRoot "dist\demos"
if (Test-Path -LiteralPath $bundledDemo) {
  Remove-Item -LiteralPath $bundledDemo -Recurse -Force
}

# TypeScript also emits test files; a runtime archive must not ship test fixtures.
$bundledServer = Join-Path $stagingRoot "server-dist"
Get-ChildItem -LiteralPath $bundledServer -Filter "*.test.js" -Recurse -File | ForEach-Object {
  Remove-Item -LiteralPath $_.FullName -Force
}

$installNote = @"
# Axiom v$version deployment bundle

1. Copy .env.example to .env.local and provide your own secrets.
2. Run: npm ci --omit=dev
   For a single-instance setup, run: node scripts/setup-local-provider-secret.mjs
   Back up the generated .env.local securely. All workers must share its key.
3. For PostgreSQL, run: npm run db:migrate
4. Start the combined API and web service: npm start
5. Open the configured API_PORT (default: http://127.0.0.1:8787).

This archive never includes .env.local, local databases, Artifact data, logs,
node_modules, demo files, QA screenshots, or API keys.
See README.md and docs/migration-v2.3.md before upgrading an existing deployment.
"@
Set-Content -LiteralPath (Join-Path $stagingRoot "DEPLOY.txt") -Value $installNote -Encoding UTF8

Compress-Archive -LiteralPath $stagingRoot -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath $checksumPath -Value "$hash  $bundleName.zip" -Encoding ASCII

Remove-Item -LiteralPath $stagingRoot -Recurse -Force

Write-Output "Release archive: $zipPath"
Write-Output "SHA-256: $hash"
Write-Output "Checksum file: $checksumPath"
