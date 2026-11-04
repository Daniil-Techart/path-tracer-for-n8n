$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
node (Join-Path $root 'scripts/sync-extension.mjs') | Out-Null
$manifest = Get-Content (Join-Path $root 'extension/manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$zip = Join-Path $dist ("path-tracer-for-n8n-$version.zip")
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $root 'extension/*') -DestinationPath $zip -Force
Write-Output $zip
