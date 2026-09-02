@echo off
rem Install EVERYTHING host-draft.bat needs on Windows - no Microsoft Store,
rem no winget, no admin rights. Safe to run twice; it skips what you have.
rem
rem   install-dependencies.bat     (double-click it, or run from a terminal)
rem
rem What it sets up:
rem   - Node.js  : if "node" is not on PATH, downloads the official portable
rem                ZIP from nodejs.org into %USERPROFILE%\.mtgdraft\node\
rem   - cloudflared : if not on PATH, downloads the official exe from
rem                Cloudflare's GitHub releases to %USERPROFILE%\.cloudflared\
rem   - npm packages for the relay server (runs npm install in this folder)
rem
rem host-draft.bat finds all of these automatically - no PATH changes made.
rem Needs curl, which is built into Windows 10 and newer.

setlocal
cd /d "%~dp0"

rem Bump this to update the bundled portable Node.
set "NODE_VERSION=22.12.0"
set "NODE_DIR=%USERPROFILE%\.mtgdraft\node"
set "CF_DIR=%USERPROFILE%\.cloudflared"

where curl >nul 2>nul
if errorlevel 1 (
  echo [setup] curl is required - it is built into Windows 10 and newer.
  goto :faildone
)

rem ---------------- Node.js ----------------
where node >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%v in ('node --version 2^>nul') do echo [setup] Node.js already installed on PATH: %%v
  goto :node_done
)
if exist "%NODE_DIR%\node.exe" (
  echo [setup] Portable Node.js already installed: %NODE_DIR%
  goto :node_done
)
echo [setup] Downloading portable Node.js v%NODE_VERSION% from nodejs.org - about 30MB...
if not exist "%USERPROFILE%\.mtgdraft" mkdir "%USERPROFILE%\.mtgdraft"
curl -fSL -o "%USERPROFILE%\.mtgdraft\node.zip" "https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip"
if errorlevel 1 (
  echo [setup] Node.js download failed - check your internet connection.
  goto :faildone
)
echo [setup] Unpacking...
rem tar.exe ships with Windows 10+ and extracts ZIPs - no PowerShell needed.
tar -xf "%USERPROFILE%\.mtgdraft\node.zip" -C "%USERPROFILE%\.mtgdraft"
if errorlevel 1 (
  echo [setup] Could not unpack the Node.js ZIP.
  goto :faildone
)
if exist "%NODE_DIR%" rmdir /s /q "%NODE_DIR%"
move "%USERPROFILE%\.mtgdraft\node-v%NODE_VERSION%-win-x64" "%NODE_DIR%" >nul
del "%USERPROFILE%\.mtgdraft\node.zip" >nul 2>nul
if not exist "%NODE_DIR%\node.exe" (
  echo [setup] Node.js unpack did not produce node.exe - see %USERPROFILE%\.mtgdraft
  goto :faildone
)
for /f "delims=" %%v in ('"%NODE_DIR%\node.exe" --version 2^>nul') do echo [setup] Portable Node.js installed: %%v
:node_done

rem ---------------- cloudflared ----------------
where cloudflared >nul 2>nul
if not errorlevel 1 (
  echo [setup] cloudflared already installed on PATH.
  goto :cf_done
)
if exist "%CF_DIR%\cloudflared.exe" (
  echo [setup] cloudflared already installed: %CF_DIR%
  goto :cf_done
)
echo [setup] Downloading cloudflared from Cloudflare's GitHub releases...
if not exist "%CF_DIR%" mkdir "%CF_DIR%"
curl -fSL -o "%CF_DIR%\cloudflared.exe" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
if errorlevel 1 (
  echo [setup] cloudflared download failed - check your internet connection.
  goto :faildone
)
"%CF_DIR%\cloudflared.exe" --version >nul 2>nul
if errorlevel 1 (
  echo [setup] downloaded cloudflared does not run on this system.
  goto :faildone
)
echo [setup] cloudflared installed: %CF_DIR%\cloudflared.exe
:cf_done

rem ---------------- relay server npm packages ----------------
if exist node_modules\ws (
  echo [setup] Relay server packages already installed.
  goto :npm_done
)
set "NPM_CMD=npm"
where npm >nul 2>nul
if errorlevel 1 set "NPM_CMD=%NODE_DIR%\npm.cmd"
echo [setup] Installing relay server packages...
call "%NPM_CMD%" install --no-audit --no-fund >nul
if errorlevel 1 (
  echo [setup] npm install failed.
  goto :faildone
)
echo [setup] Relay server packages installed.
:npm_done

echo.
echo [setup] All set - run host-draft.bat to host a draft.
if "%~1"=="" pause
exit /b 0

:faildone
if "%~1"=="" pause
exit /b 1
