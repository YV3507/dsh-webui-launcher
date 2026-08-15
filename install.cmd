@echo off
setlocal
rem DeepSeek Harness Web UI quick-launch installer.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo.
  echo Installation failed. See the messages above.
  pause
)
endlocal
