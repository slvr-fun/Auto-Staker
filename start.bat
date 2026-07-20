@echo off
rem SLVR Auto-Staker — Windows launcher.
rem Double-click this file to start the app. First run installs everything it needs.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed yet.
  echo   Please download the LTS version from https://nodejs.org and install it,
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run - installing dependencies, this takes a minute...
  call npm install --no-fund --no-audit
  if errorlevel 1 ( pause & exit /b 1 )
)

call npm start
pause
