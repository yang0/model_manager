@echo off
setlocal

cd /d "%~dp0"

if not exist node_modules (
  echo [ERROR] node_modules not found. Run: npm install
  pause
  exit /b 1
)

echo Releasing occupied ports (3199/5173/5174) if needed...
for %%P in (3199 5173 5174) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do (
    if not "%%I"=="0" (
      echo - Port %%P in use by PID %%I, stopping...
      taskkill /PID %%I /F >nul 2>nul
    )
  )
)

echo Starting Model Manager in single window...
echo Backend:  http://127.0.0.1:3199
echo Frontend: http://127.0.0.1:5173
echo Press Ctrl+C to stop both services.
echo.
call npm run dev
if errorlevel 1 (
  echo.
  echo [ERROR] Start failed.
  pause
)
endlocal
