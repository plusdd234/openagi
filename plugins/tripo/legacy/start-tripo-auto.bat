@echo off
chcp 65001 >nul
title Tripo Web Auto (legacy)
cd /d "%~dp0..\..\.."

if exist "node_modules\playwright-core\package.json" goto run
echo Installing playwright-core...
call npm.cmd install playwright-core --no-save --no-audit --no-fund
if errorlevel 1 goto fail

:run
node plugins\tripo\tripo-web.js %*
pause
exit /b 0

:fail
echo Install failed. Check your network and retry.
pause
exit /b 1