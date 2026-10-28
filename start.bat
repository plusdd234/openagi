@echo off
rem The seed launcher (pure ASCII, CRLF)
title The seed Launcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto noNode

if not exist "node_modules\electron\package.json" goto needInstall

set "ELECTRON_EXE=node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" goto noElectron

if /i "%~1"=="--browser" goto browser

:desktop
echo.
echo  [Desktop mode] Starting The seed ...
echo  Local services: relay=8787  tripo=8790  chat=8792  runtime=8794
echo  Closing this window quits everything.
echo.
echo  Launching: %ELECTRON_EXE%
"%ELECTRON_EXE%" .
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo  [Error] Desktop launch failed, exit code=%EXITCODE%
  echo  Check log: %APPDATA%\The seed\boot.log
)
echo.
echo  Desktop exited.
pause
exit /b %EXITCODE%

:browser
echo.
echo  [Browser mode] Starting local services and opening page in browser ...
echo  Note: close the desktop app first to avoid port conflicts.
echo.
start "Tripo Bridge" /min "%~dp0plugins\tripo\legacy\start-tripo-bridge.bat"
start "" "%~dp0index.html"
node plugins\relay\relay.js
echo.
echo  Relay stopped.
pause
exit /b 0

:noNode
echo.
echo  [Error] Node.js not found. Install it first: https://nodejs.org
pause
exit /b 1

:needInstall
echo.
echo  [First run] Installing dependencies, please wait ...
echo  Note: electron downloads ~100MB; long silence is normal.
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo.
  echo  [Error] Dependency install failed.
  echo  If the window was black with no output, run this from
  echo  "Command Prompt (CMD)" instead:  npm.cmd install
  pause
  exit /b 1
)
echo.
echo  Install finished, continuing to launch ...
goto desktop

:noElectron
echo.
echo  [Error] %ELECTRON_EXE% not found.
echo  Run in "Command Prompt (CMD)":  npm.cmd install
pause
exit /b 1
