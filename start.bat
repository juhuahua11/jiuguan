@echo off
chcp 65001 >nul
cd /d "%~dp0"
title jiuguan AI Chat

echo ============================================================
echo   jiuguan AI Chat Server
echo ============================================================
echo   Starting server on port 3111...
echo   Browser will open shortly. Close this window to stop.
echo ============================================================
echo.

start "" http://localhost:3111
node server.js

echo.
echo Server stopped. Press any key to exit.
pause >nul
