# -*- coding: utf-8 -*-
# 卸载定时检测 IPv6 的计划任务（需管理员身份运行）
param([string]$TaskName = 'IPv6-Reporter-GitHub')

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host '请以管理员身份运行。' -ForegroundColor Red; exit 1 }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "计划任务 [$TaskName] 已删除。" -ForegroundColor Green
} else {
    Write-Host "未找到计划任务 [$TaskName]。" -ForegroundColor Yellow
}
Write-Host "工作副本、状态和日志如需清理：$env:LOCALAPPDATA\ipv6-reporter" -ForegroundColor Gray
