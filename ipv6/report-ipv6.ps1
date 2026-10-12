# -*- coding: utf-8 -*-
<#
.SYNOPSIS
    检测本机公网 IPv6，一旦变化就加密写入 ipv6/data.json 并 git 提交推送到 GitHub Pages。
.DESCRIPTION
    由计划任务定时调用（见 install-task.ps1），也可以手动运行。

    为了不碰你日常写博客的工作区（未提交的改动、本地还没推的提交），
    提交是在一个独立的浅克隆里完成的：%LOCALAPPDATA%\ipv6-reporter\repo
    远程地址取自本脚本所在仓库的 origin。

    地址没变时只做本地比对，不联网、不提交；每 24 小时会跟远端核对一次。
    配置读取同目录 config.json（不入库），其中 password 必填，字段见 config.example.json。
#>
[CmdletBinding()]
param(
    # 忽略本地缓存，强制跟远端核对一次
    [switch]$Force,
    # 开机时网络可能尚未就绪，取不到 IPv6 时的重试次数
    [int]$MaxRetry = 10,
    # 每次重试间隔（秒）
    [int]$RetryDelay = 20
)

$ErrorActionPreference = 'Stop'

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceRepo = Split-Path -Parent $scriptDir
$configPath = Join-Path $scriptDir 'config.json'

$appData = $env:LOCALAPPDATA
if (-not $appData) { $appData = [Environment]::GetFolderPath('LocalApplicationData') }
$stateDir  = Join-Path $appData 'ipv6-reporter'
$workDir   = Join-Path $stateDir 'repo'
$stateFile = Join-Path $stateDir 'state.json'
$logFile   = Join-Path $stateDir 'report.log'
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }

$utf8NoBom = New-Object Text.UTF8Encoding $false

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Host $line
    try {
        Add-Content -Path $logFile -Value $line -Encoding utf8
        # 日志超过 1MB 时截断保留后半部分
        if ((Get-Item $logFile).Length -gt 1MB) {
            $keep = Get-Content $logFile -Tail 500
            Set-Content -Path $logFile -Value $keep -Encoding utf8
        }
    } catch { }
}

function Now-Iso { (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz') }

# ------------------------------------------------------------ 配置
$cfg = $null
if (Test-Path $configPath) {
    $cfg = Get-Content $configPath -Raw -Encoding utf8 | ConvertFrom-Json
}
$hostName = if ($cfg -and $cfg.host_name) { [string]$cfg.host_name } else { $env:COMPUTERNAME }
$note     = if ($cfg -and $cfg.note) { [string]$cfg.note } else { '' }
$branch   = if ($cfg -and $cfg.branch) { [string]$cfg.branch } else { 'master' }
$password = if ($cfg -and $cfg.password) { [string]$cfg.password } else { '' }
if (-not $password) {
    Write-Log "config.json 里没有 password，数据要加密后才能上传（运行 install-task.ps1 会引导设置）：$configPath" 'ERROR'
    exit 1
}

# ------------------------------------------------------------ 加密
# 仓库是公开的，data.json 只存密文；网页上输入同一个密码，在浏览器里本地解密。
# PBKDF2-SHA256 从密码派生 64 字节：前 32 字节做 AES-256-CBC 密钥，后 32 字节做 HMAC-SHA256 密钥。
# 先加密后 MAC（encrypt-then-MAC），密码错误或密文被改都能识别出来。
# .NET Framework 没有 AES-GCM，所以用 CBC + HMAC；这套组合浏览器的 WebCrypto 也都支持。
$KdfIterations = 200000

function Get-DerivedKeys {
    param([string]$Password, [byte[]]$Salt, [int]$Iterations)
    $kdf = New-Object Security.Cryptography.Rfc2898DeriveBytes($Password, $Salt, $Iterations,
        [Security.Cryptography.HashAlgorithmName]::SHA256)
    $bytes = $kdf.GetBytes(64)
    $kdf.Dispose()
    return @{ enc = $bytes[0..31]; mac = $bytes[32..63] }
}

function Get-Hmac {
    param([byte[]]$Key, [byte[]]$Data)
    $h = New-Object Security.Cryptography.HMACSHA256(, $Key)
    try { return $h.ComputeHash($Data) } finally { $h.Dispose() }
}

function Protect-Text {
    param([string]$Text, [string]$Password)
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $salt = New-Object byte[] 16; $rng.GetBytes($salt)
    $iv   = New-Object byte[] 16; $rng.GetBytes($iv)
    $keys = Get-DerivedKeys -Password $Password -Salt $salt -Iterations $KdfIterations

    $aes = [Security.Cryptography.Aes]::Create()
    $aes.Mode = 'CBC'; $aes.Padding = 'PKCS7'
    $aes.Key = $keys.enc; $aes.IV = $iv
    $plain = $utf8NoBom.GetBytes($Text)
    $ct = $aes.CreateEncryptor().TransformFinalBlock($plain, 0, $plain.Length)
    $aes.Dispose()

    $mac = Get-Hmac -Key $keys.mac -Data ([byte[]]($iv + $ct))
    return [ordered]@{
        v    = 1
        alg  = 'PBKDF2-SHA256 / AES-256-CBC / HMAC-SHA256'
        iter = $KdfIterations
        salt = [Convert]::ToBase64String($salt)
        iv   = [Convert]::ToBase64String($iv)
        ct   = [Convert]::ToBase64String($ct)
        mac  = [Convert]::ToBase64String($mac)
    }
}

function Unprotect-Text {
    param($Box, [string]$Password)
    $salt = [Convert]::FromBase64String($Box.salt)
    $iv   = [Convert]::FromBase64String($Box.iv)
    $ct   = [Convert]::FromBase64String($Box.ct)
    $mac  = [Convert]::FromBase64String($Box.mac)
    $keys = Get-DerivedKeys -Password $Password -Salt $salt -Iterations ([int]$Box.iter)

    $expect = Get-Hmac -Key $keys.mac -Data ([byte[]]($iv + $ct))
    if ([Convert]::ToBase64String($expect) -ne [Convert]::ToBase64String($mac)) {
        throw '解密失败：密码与远端数据不一致（或数据已损坏）。为避免覆盖其他机器的记录，本次不写入。'
    }
    $aes = [Security.Cryptography.Aes]::Create()
    $aes.Mode = 'CBC'; $aes.Padding = 'PKCS7'
    $aes.Key = $keys.enc; $aes.IV = $iv
    $plain = $aes.CreateDecryptor().TransformFinalBlock($ct, 0, $ct.Length)
    $aes.Dispose()
    return $utf8NoBom.GetString($plain)
}

# ------------------------------------------------------------ git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Log '找不到 git，请确认 Git for Windows 已安装并在 PATH 中' 'ERROR'
    exit 1
}
# 后台运行没有终端，别让 git 卡在交互提示上
$env:GIT_TERMINAL_PROMPT = '0'

function Invoke-Git {
    # git 会往 stderr 写进度信息，PowerShell 5.1 在 Stop 模式下会把它当成异常，
    # 所以这里临时放宽，改用退出码判断成败。
    $ErrorActionPreference = 'Continue'
    $out = & git @args 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) {
        throw ('git {0} 失败：{1}' -f ($args -join ' '), ($out -join ' | '))
    }
    return $out
}

# ------------------------------------------------------------ 机器标识
function Get-MachineId {
    $raw = $null
    try {
        $raw = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid
    } catch { }
    if (-not $raw) {
        try { $raw = (Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop).UUID } catch { }
    }
    if (-not $raw) { $raw = $env:COMPUTERNAME }
    # 页面是公开的，不直接暴露 MachineGuid，只取它的哈希前 12 位
    $sha = [Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($raw))
    return (($hash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
}

# ------------------------------------------------------------ 采集 IPv6
function Get-PublicIPv6 {
    # 只要全局单播地址：排除 link-local(fe80::/10)、回环(::1)、
    # 唯一本地地址(fc00::/7) 和已废弃 / 重复的地址
    $addrs = Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notmatch '^(fe80|::1$|fc|fd)' -and
            $_.AddressState -in @('Preferred', 'Tentative') -and
            $_.PrefixOrigin -ne 'WellKnown'
        }

    # 过滤掉已断开的网卡
    $upIdx = (Get-NetAdapter -ErrorAction SilentlyContinue |
              Where-Object Status -eq 'Up').ifIndex
    if ($upIdx) {
        $addrs = $addrs | Where-Object { $upIdx -contains $_.InterfaceIndex }
    }

    # ValidLifetime 长的是稳定的“公用地址”，短的是会轮换的“临时地址”，
    # 因此按有效期降序，取第一个作为主地址。
    $addrs = $addrs | Sort-Object -Property @{
        Expression = { $_.ValidLifetime.TotalSeconds }; Descending = $true
    }
    return $addrs
}

function Get-LocalIPv4 {
    param([int]$PreferInterfaceIndex = 0)

    $v4 = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.AddressState -eq 'Preferred' })
    if ($v4.Count -eq 0) { return '' }

    # 优先取与公网 IPv6 同一块网卡的地址，避免选中虚拟机 / VPN 虚拟网卡
    if ($PreferInterfaceIndex) {
        $same = $v4 | Where-Object InterfaceIndex -eq $PreferInterfaceIndex | Select-Object -First 1
        if ($same) { return $same.IPAddress }
    }
    return $v4[0].IPAddress
}

# ------------------------------------------------------------ 工作副本
function Sync-WorkRepo {
    param([string]$RemoteUrl)
    if (-not (Test-Path (Join-Path $workDir '.git'))) {
        if (Test-Path $workDir) { Remove-Item $workDir -Recurse -Force }
        Write-Log "首次运行，浅克隆仓库到 $workDir"
        Invoke-Git clone --depth 1 --single-branch --branch $branch $RemoteUrl $workDir | Out-Null
        return
    }
    Invoke-Git -C $workDir remote set-url origin $RemoteUrl | Out-Null
    Invoke-Git -C $workDir fetch --depth 1 origin $branch | Out-Null
    Invoke-Git -C $workDir reset --hard FETCH_HEAD | Out-Null
}

# 把本机这条记录写进 data.json；内容没变返回 $false
function Update-DataFile {
    param([string]$Path, [hashtable]$Report, [string]$Password)

    $data = $null
    if (Test-Path $Path) {
        $text = [IO.File]::ReadAllText($Path, $utf8NoBom)
        if ($text.Trim()) { $data = $text | ConvertFrom-Json }
    }
    # 密文格式先解密；没有 ct 字段的是初始的空文件（明文），直接用
    if ($data -and $data.ct) {
        $data = Unprotect-Text -Box $data -Password $Password | ConvertFrom-Json
    }
    $list = New-Object System.Collections.ArrayList
    if ($data -and $data.hosts) { foreach ($h in @($data.hosts)) { [void]$list.Add($h) } }

    $idx = -1
    for ($i = 0; $i -lt $list.Count; $i++) {
        if ($list[$i].id -eq $Report.id) { $idx = $i; break }
    }
    $old = if ($idx -ge 0) { $list[$idx] } else { $null }

    $ipChanged = (-not $old) -or ($old.ipv6_primary -ne $Report.ipv6_primary)
    if (-not $ipChanged -and
        $old.ipv4_local -eq $Report.ipv4_local -and
        $old.host_name -eq $Report.host_name -and
        $old.note -eq $Report.note) {
        return $false
    }

    $ts = Now-Iso
    $history = @()
    if ($ipChanged) { $history += [ordered]@{ ipv6 = $Report.ipv6_primary; at = $ts } }
    if ($old -and $old.history) { $history += @($old.history) }
    $history = @($history | Select-Object -First 10)

    $entry = [ordered]@{
        id           = $Report.id
        host_name    = $Report.host_name
        ipv6_primary = $Report.ipv6_primary
        ipv6_all     = @($Report.ipv6_all)
        ipv4_local   = $Report.ipv4_local
        os_info      = $Report.os_info
        note         = $Report.note
        first_seen   = $(if ($old -and $old.first_seen) { $old.first_seen } else { $ts })
        changed_at   = $(if ($ipChanged -or -not $old.changed_at) { $ts } else { $old.changed_at })
        updated_at   = $ts
        history      = $history
    }
    if ($idx -ge 0) { $list[$idx] = $entry } else { [void]$list.Add($entry) }

    $out = [ordered]@{ updated_at = $ts; hosts = @($list) }
    $plain = ConvertTo-Json -InputObject $out -Depth 8 -Compress
    $box = Protect-Text -Text $plain -Password $Password
    $json = ConvertTo-Json -InputObject $box
    [IO.File]::WriteAllText($Path, $json + "`n", $utf8NoBom)
    return $true
}

# ------------------------------------------------------------ 主流程

# 1. 取地址（开机时网络可能还没好，多试几次）
$v6 = @()
for ($attempt = 1; $attempt -le $MaxRetry; $attempt++) {
    $v6 = @(Get-PublicIPv6)
    if ($v6.Count -gt 0) { break }
    Write-Log "第 $attempt/$MaxRetry 次：尚未获取到公网 IPv6 地址，${RetryDelay} 秒后重试" 'WARN'
    if ($attempt -lt $MaxRetry) { Start-Sleep -Seconds $RetryDelay }
}
if ($v6.Count -eq 0) {
    Write-Log "已重试 $MaxRetry 次仍未获取到公网 IPv6，本次放弃" 'ERROR'
    exit 1
}

$all = @($v6 | ForEach-Object { $_.IPAddress })
$osInfo = try {
    $o = Get-CimInstance Win32_OperatingSystem
    '{0} {1}' -f $o.Caption.Trim(), $o.Version
} catch { 'Windows' }

$report = @{
    id           = Get-MachineId
    host_name    = $hostName
    ipv6_primary = $all[0]
    ipv6_all     = $all
    ipv4_local   = Get-LocalIPv4 -PreferInterfaceIndex $v6[0].InterfaceIndex
    os_info      = $osInfo
    note         = $note
}

# 2. 跟上次成功上报的结果比对，没变就直接结束（不联网）
$state = $null
if (Test-Path $stateFile) {
    try { $state = Get-Content $stateFile -Raw -Encoding utf8 | ConvertFrom-Json } catch { }
}
$fingerprint = '{0}|{1}|{2}|{3}' -f $report.ipv6_primary, $report.ipv4_local, $report.host_name, $report.note
$recentlyChecked = $false
if ($state -and $state.checked_at) {
    try { $recentlyChecked = ((Get-Date) - [datetime]$state.checked_at).TotalHours -lt 24 } catch { }
}
if (-not $Force -and $state -and $state.fingerprint -eq $fingerprint -and $recentlyChecked) {
    Write-Verbose "地址未变化：$($report.ipv6_primary)"
    exit 0
}

# 3. 同步工作副本 → 改 data.json → 提交 → 推送；推送被拒（别的机器刚推过）就重来
try {
    $remoteUrl = (Invoke-Git -C $sourceRepo remote get-url origin | Select-Object -First 1).Trim()
    $relPath = 'ipv6/data.json'
    $pushed = $false
    $changed = $false

    for ($round = 1; $round -le 3 -and -not $pushed; $round++) {
        Sync-WorkRepo -RemoteUrl $remoteUrl
        $dataPath = Join-Path $workDir $relPath
        $changed = Update-DataFile -Path $dataPath -Report $report -Password $password
        if (-not $changed) { $pushed = $true; break }

        Invoke-Git -C $workDir add -- $relPath | Out-Null
        # 提交信息是公开的，不能带主机名和地址
        $msg = 'ipv6: update'
        Invoke-Git -C $workDir commit -q -m $msg -- $relPath | Out-Null
        try {
            Invoke-Git -C $workDir push origin "HEAD:$branch" | Out-Null
            $pushed = $true
        } catch {
            Write-Log "第 $round 次推送失败，将重新同步后再试：$($_.Exception.Message)" 'WARN'
        }
    }

    if (-not $pushed) { throw '多次推送均失败' }

    if ($changed) {
        Write-Log "已提交并推送：$($report.host_name) $($report.ipv6_primary)"
    } else {
        Write-Log "远端记录已是最新：$($report.ipv6_primary)"
    }

    $newState = [ordered]@{ fingerprint = $fingerprint; checked_at = (Get-Date).ToString('o') }
    [IO.File]::WriteAllText($stateFile, (ConvertTo-Json -InputObject $newState), $utf8NoBom)
    exit 0
} catch {
    Write-Log "上报失败：$($_.Exception.Message)" 'ERROR'
    exit 1
}
