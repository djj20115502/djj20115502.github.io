@echo off
chcp 65001 >nul 2>&1
rem IPv6 上报入口，双击即可：
rem   首次运行：自动申请管理员权限，设置加密密码，注册计划任务（之后开机自动运行、每 5 分钟检测一次），并立即上报一次
rem   已安装后：手动上报一次（带 -Force，跳过本地缓存、强制跟远端核对）
rem   report-ipv6.bat --install   强制重新安装（例如挪动了仓库位置）
cd /d "%~dp0"
set "TASK=IPv6-Reporter-GitHub"

if /i "%~1"=="--install" goto install
schtasks /query /tn "%TASK%" >nul 2>&1
if errorlevel 1 goto need_install

rem ---------------------------------------------------------------- 手动上报一次
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0report-ipv6.ps1" -Force %*
set "code=%errorlevel%"
if "%code%"=="0" (echo. & echo 上报完成。) else (echo. & echo 上报失败，退出码 %code%，日志：%LOCALAPPDATA%\ipv6-reporter\report.log)
rem 双击运行时停一下，方便看结果；在命令行里调用则直接返回
echo %cmdcmdline% | "%SystemRoot%\System32\find.exe" /i "%~0" >nul && pause
exit /b %code%

rem ---------------------------------------------------------------- 首次安装
:need_install
echo 首次运行：需要管理员权限来注册开机自动运行的计划任务。
net session >nul 2>&1 && goto install
echo 即将弹出 UAC 确认，安装会在新打开的管理员窗口里进行……
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '--install' -Verb RunAs"
exit /b 0

:install
net session >nul 2>&1 || (echo 需要管理员权限，请右键「以管理员身份运行」。 & pause & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-task.ps1"
set "code=%errorlevel%"
echo.
if "%code%"=="0" (echo 安装完成，以后每次开机都会自动检测并上报。) else (echo 安装失败，退出码 %code%。)
pause
exit /b %code%
