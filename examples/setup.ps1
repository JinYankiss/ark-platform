# 项目接入适配：只在明确的当前项目目录内创建本地开发凭据，不覆盖已有文件。
$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Set-Location -LiteralPath $root
New-Item -ItemType Directory -Force -Path (Join-Path $root ".data") | Out-Null
$credentialsPath = Join-Path $root ".data/credentials.json"
if (-not (Test-Path -LiteralPath $credentialsPath)) {
    $userToken = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
    $runnerToken = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
    $adminToken = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
    @(
        @{ token = $userToken; principal = @{ id = "intern"; businessLine = "engineering"; role = "user" } },
        @{ token = $runnerToken; principal = @{ id = "local-runner"; businessLine = "engineering"; role = "runner" } },
        @{ token = $adminToken; principal = @{ id = "operator"; businessLine = "engineering"; role = "admin" } }
    ) | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $credentialsPath -Encoding utf8NoBOM
}
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }
npm run seed
if ($LASTEXITCODE -ne 0) { throw "Seed failed" }
Write-Output "Local files prepared. Credentials are in .data/credentials.json; do not commit or share them."
