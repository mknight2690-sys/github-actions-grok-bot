@echo off
cd /d "%~dp0"
echo ============================================
echo  Cloud Agent Controller
echo ============================================
echo.
echo Working folder: %CD%
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not in PATH.
  echo Download LTS from https://nodejs.org and restart this window.
  pause
  exit /b 1
)

echo Node version:
node -v
echo.

if not exist "node_modules\electron" (
  echo Installing dependencies (this can take a few minutes)...
  call npm install --loglevel=error
  if errorlevel 1 (
    echo.
    echo npm install FAILED. See messages above.
    pause
    exit /b 1
  )
) else (
  echo Dependencies already present.
)

echo.
echo Launching Electron...
echo If a window does not open, the error will show below.
echo.

set ELECTRON_ENABLE_LOGGING=1
call npx electron . --enable-logging
set EXITCODE=%ERRORLEVEL%

echo.
echo Electron exited with code %EXITCODE%
if not %EXITCODE%==0 (
  echo.
  echo Something went wrong. Common fixes:
  echo  1. Delete the node_modules folder and run this bat again
  echo  2. Run: npm install electron@33.2.0
  echo  3. Make sure Windows Defender did not block electron.exe
)
echo.
pause
