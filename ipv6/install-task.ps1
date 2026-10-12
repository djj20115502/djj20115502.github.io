# -*- coding: utf-8 -*-
<#
.SYNOPSIS
    注册 Windows 计划任务，定时检测 IPv6 变化并推送到 GitHub。
.DESCRIPTION
    需要以「管理员身份」运行 PowerShell 后执行本脚本（注册开机触发的任务需要管理员权限）。
    任务以「当前用户」身份、S4U 方式运行：不需要登录、不弹窗，
    并且能用到当前用户的 git 配置和 SSH 密钥（推送要用）。
    触发条件：开机后 1 分钟 + 之后每隔 N 分钟检测一次。
    地址没变时脚本只做本地比对，不联网、不产生提交，所以间隔可以设得短一些。
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'IPv6-Reporter-GitHub',
    # 检测间隔（分钟），设为 0 表示只在开机时检测一次
    [int]$IntervalMinutes = 5
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal] $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '请以管理员身份重新运行 PowerShell 后再执行本脚本。' -ForegroundColor Red
    exit 1
}

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$reportPath = Join-Path $scriptDir 'report-ipv6.ps1'
if (-not (Test-Path $reportPath)) { Write-Host "找不到 $reportPath" -ForegroundColor Red; exit 1 }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host '找不到 git，请先安装 Git for Windows。' -ForegroundColor Red
    exit 1
}

# 数据要加密上传，密码只存在本机 config.json（已被 .gitignore 排除，不会入库）
$configPath = Join-Path $scriptDir 'config.json'
$cfg = if (Test-Path $configPath) { Get-Content $configPath -Raw -Encoding utf8 | ConvertFrom-Json } else { $null }
if (-not $cfg -or -not $cfg.password) {
    Write-Host '还没有设置加密密码。网页上查看地址时需要输入这个密码；多台机器要用同一个密码。' -ForegroundColor Cyan
    while ($true) {
        $p1 = Read-Host '设置密码' -AsSecureString
        $p2 = Read-Host '再输一次' -AsSecureString
        $s1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1))
        $s2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2))
        if ($s1 -ne $s2) { Write-Host '两次输入不一致，请重输。' -ForegroundColor Yellow; continue }
        if ($s1.Length -lt 8) { Write-Host '密码至少 8 位（数据是公开的，弱密码可以被暴力破解）。' -ForegroundColor Yellow; continue }
        break
    }
    $new = [ordered]@{
        host_name = $(if ($cfg -and $cfg.host_name) { $cfg.host_name } else { '' })
        note      = $(if ($cfg -and $cfg.note) { $cfg.note } else { '' })
        branch    = $(if ($cfg -and $cfg.branch) { $cfg.branch } else { 'master' })
        password  = $s1
    }
    [IO.File]::WriteAllText($configPath, (ConvertTo-Json -InputObject $new), (New-Object Text.UTF8Encoding $false))
    Write-Host "已写入 $configPath" -ForegroundColor Gray
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $reportPath) `
    -WorkingDirectory $scriptDir

$triggers = @()

# 开机触发，延迟 1 分钟等待网络就绪
$bootTrigger = New-ScheduledTaskTrigger -AtStartup
$bootTrigger.Delay = 'PT1M'
$triggers += $bootTrigger

# 周期性检测（运营商随时可能更换 IPv6 前缀）
if ($IntervalMinutes -gt 0) {
    $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
    $triggers += $repeat
}

# S4U：以当前用户身份运行，无需保存密码，用户未登录时也会运行
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已移除同名的旧任务 $TaskName"
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Principal $principal -Settings $settings `
    -Description '检测本机公网 IPv6，变化时提交到 GitHub Pages 博客仓库的 ipv6/data.json' | Out-Null

$logFile = Join-Path $env:LOCALAPPDATA 'ipv6-reporter\report.log'
Write-Host "计划任务 [$TaskName] 注册成功（运行身份：$($identity.Name)）。" -ForegroundColor Green
Write-Host "  开机后 1 分钟触发一次" -ForegroundColor Gray
if ($IntervalMinutes -gt 0) {
    Write-Host "  之后每 $IntervalMinutes 分钟检测一次" -ForegroundColor Gray
}
Write-Host "  日志：$logFile" -ForegroundColor Gray

if (Get-ScheduledTask -TaskName 'IPv6-Reporter' -ErrorAction SilentlyContinue) {
    Write-Host ''
    Write-Host '检测到旧版（上报到自建服务器）的计划任务 [IPv6-Reporter]，不再需要的话可以执行：' -ForegroundColor Yellow
    Write-Host "  Unregister-ScheduledTask -TaskName 'IPv6-Reporter' -Confirm:`$false" -ForegroundColor Yellow
}

Write-Host ''
Write-Host '正在立即触发一次以验证（首次需要克隆仓库，可能要几十秒）……' -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    if ((Get-ScheduledTask -TaskName $TaskName).State -ne 'Running') { break }
}
Get-ScheduledTaskInfo -TaskName $TaskName | Format-List TaskName, LastRunTime, LastTaskResult, NextRunTime
if (Test-Path $logFile) {
    Write-Host '最近的日志：' -ForegroundColor Gray
    Get-Content $logFile -Tail 5
}
Write-Host '（LastTaskResult 为 0 表示成功。）' -ForegroundColor Gray
