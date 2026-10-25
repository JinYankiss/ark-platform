param(
    [ValidateSet("direct", "workflow", "draft")][string]$Mode = "direct",
    [string]$Prompt = "请说明 Runner 如何恢复任务",
    [string]$Workflow = "bug-intake@1.0.0"
)
$ErrorActionPreference = "Stop"
$credentials = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "../.data/credentials.json") | ConvertFrom-Json
$user = $credentials | Where-Object { $_.principal.role -eq "user" } | Select-Object -First 1
$headers = @{ Authorization = "Bearer $($user.token)"; "Idempotency-Key" = [guid]::NewGuid().ToString() }
$body = @{ mode = $Mode; prompt = $Prompt }
if ($Mode -eq "workflow") { $body.workflow = $Workflow }
Invoke-RestMethod -Uri "http://127.0.0.1:8787/tasks" -Method Post -Headers $headers `
    -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json)))
