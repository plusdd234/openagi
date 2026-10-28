@echo off
chcp 65001 >nul
title Tripo Bridge (legacy)
cd /d "%~dp0..\..\.."

if exist "node_modules\playwright-core\package.json" goto run
echo Installing playwright-core...
call npm.cmd install playwright-core --no-save --no-audit --no-fund
if errorlevel 1 goto fail

:run
rem 桥会自动拉起一个「普通方式启动的 Edge」（带远程调试端口 9222），
rem 这样浏览器没有自动化特征，Cloudflare 的「验证真人」不会反复弹。
rem 想让 Tripo 走直连（绕过本机代理）时，先设置环境变量再运行本脚本：
rem   set TRI_EDGE_ARGS=--proxy-server=direct:// --proxy-bypass-list=*
rem 也可以先运行 start-tripo-edge.bat 自己开一个 Edge，桥会直接连它。
node plugins\tripo\tripo-web.js --serve
pause
exit /b 0

:fail
echo Install failed. Check your network and retry.
pause
exit /b 1