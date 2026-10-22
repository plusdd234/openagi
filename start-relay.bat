@echo off
chcp 65001 >nul
title Open AGI Launcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first: https://nodejs.org
  pause
  exit /b 1
)

echo.
echo  Open AGI local services
echo  Relay : http://127.0.0.1:8787
echo  Tripo : http://127.0.0.1:8790  (opens a browser only when you click "Open login page")
echo  Keep this window open. Close it to stop the relay.
echo.

start "Tripo Bridge" /min "%~dp0start-tripo-bridge.bat"
start "" "index.html"
node relay.js

echo.
echo Relay stopped.
pause
