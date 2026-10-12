@echo off
rem IPv6 reporter entry. Keep this file ASCII-only: cmd mis-parses multi-byte (UTF-8) lines.
rem   First run : elevate via UAC, set password, register the boot/interval task (install-task.ps1)
rem   Afterwards: report once now (report-ipv6.ps1 -Force)
rem   report-ipv6.bat --install : force reinstall (e.g. after moving the repo)
cd /d "%~dp0"
set "TASK=IPv6-Reporter-GitHub"

if /i "%~1"=="--install" goto install
schtasks /query /tn "%TASK%" >nul 2>&1
if errorlevel 1 goto need_install

rem ---------------------------------------------------------------- report once
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0report-ipv6.ps1" -Force %*
set "code=%errorlevel%"
echo.
echo exit code %code%   (0 = OK, log: %LOCALAPPDATA%\ipv6-reporter\report.log)
rem pause only when double-clicked, not when called from a console
echo %cmdcmdline% | "%SystemRoot%\System32\find.exe" /i "%~0" >nul && pause
exit /b %code%

rem ---------------------------------------------------------------- first-time install
:need_install
net session >nul 2>&1 && goto install
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '--install' -Verb RunAs"
exit /b 0

:install
net session >nul 2>&1 || (echo Administrator rights required. & pause & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-task.ps1"
set "code=%errorlevel%"
echo.
echo exit code %code%   (0 = OK)
pause
exit /b %code%
