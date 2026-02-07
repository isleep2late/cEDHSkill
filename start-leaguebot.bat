@echo off
REM start-leaguebot.bat - Start the cEDH League Bot (Windows)
REM Double-click this file or run from Command Prompt after setting up .env
REM
REM Usage:
REM   start-leaguebot.bat            - Build and run (default)
REM   start-leaguebot.bat --no-build - Run without building first

cd /d "%~dp0"

if not exist "node_modules" (
    echo node_modules not found. Run "npm install" first.
    pause
    exit /b 1
)

if not exist ".env" (
    echo .env file not found. Copy .env.example to .env and fill in your credentials.
    pause
    exit /b 1
)

set "NO_BUILD=false"
for %%a in (%*) do (
    if "%%a"=="--no-build" set "NO_BUILD=true"
)

if not exist "logs" mkdir logs

if "%NO_BUILD%"=="false" (
    echo === Building TypeScript... ===
    call npm run build
    if errorlevel 1 (
        echo Build failed! Fix errors before starting.
        pause
        exit /b 1
    )
    echo === Build complete ===
    echo.
)

echo === Starting cEDH League Bot ===
echo Log file: logs\bot.log
echo Press Ctrl+C to stop
echo ================================
echo.

node dist/loader.js 2>&1 | powershell -Command "& { $input | Tee-Object -FilePath 'logs\bot.log' -Append }"

pause
