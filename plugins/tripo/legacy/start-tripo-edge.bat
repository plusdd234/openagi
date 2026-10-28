@echo off
chcp 65001 >nul
title Tripo Edge CDP (legacy)
cd /d "%~dp0..\..\.."

rem 用普通方式启动 Edge，并打开远程调试端口 9222。
rem 桥（tripo-web.js）会优先连接这个窗口 —— 普通启动的浏览器没有自动化特征，
rem Cloudflare 的「验证真人」不会反复弹，一次通过后长期有效。
rem 需要与 start-tripo-bridge.bat 一起使用：先运行本文件，再运行 start-tripo-bridge.bat。

set "EDGE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if "%EDGE%"=="" (
  echo [x] 找不到 Microsoft Edge，请先安装 Edge。
  pause
  exit /b 1
)

echo 正在以 CDP 模式启动 Edge（端口 9222）…
start "" "%EDGE%" --remote-debugging-port=9222 --user-data-dir="%~dp0..\..\..\plugins\tripo\.tripo-profile" --no-first-run --no-default-browser-check "https://studio.tripo3d.ai/zh/workspace/generate-image"
echo.
echo Edge 已打开。若出现「验证您是否是真人」，手动点一下即可（普通浏览器不会反复弹）。
echo 接下来请运行 start-tripo-bridge.bat 启动桥。
echo.
pause