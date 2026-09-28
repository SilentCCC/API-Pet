@echo off
setlocal
title API Pet
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node
where npm >nul 2>nul
if errorlevel 1 goto :no_npm

rem Use a mirror for the Electron desktop binary.
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

if not exist "node_modules\electron\dist\electron.exe" goto :install
if not exist "node_modules\.bin\electron.cmd" goto :install
goto :after_install

:install
if exist "package-lock.json" (
  echo [API Pet] Installing dependencies and Electron...
  call npm ci --foreground-scripts --no-audit --no-fund
  if errorlevel 1 goto :install_failed
  goto :after_install
)
echo [API Pet] Missing package-lock.json. Cannot install locked dependencies.
goto :install_failed

:after_install
if not exist "node_modules\electron\dist\electron.exe" (
  echo [API Pet] Downloading Electron binary...
  call node node_modules\electron\install.js
  if errorlevel 1 goto :install_failed
)

if not exist "node_modules\electron\dist\electron.exe" goto :install_failed
if not exist "node_modules\.bin\electron.cmd" goto :install_failed

echo [API Pet] Starting...
call npm start
if errorlevel 1 goto :start_failed
goto :end

:no_node
echo [API Pet] Node.js is not installed. Install Node.js 18 or newer from https://nodejs.org/
pause
goto :end

:no_npm
echo [API Pet] npm was not found. Please reinstall Node.js.
pause
goto :end

:install_failed
echo [API Pet] Dependency or Electron installation failed. Check the npm error above.
pause
goto :end

:start_failed
echo [API Pet] Application failed to start.
pause

:end
endlocal
