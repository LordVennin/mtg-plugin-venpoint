@echo off
rem Install cloudflared (Cloudflare quick tunnel) on Windows if you don't have it.
rem
rem   install-cloudflared.bat    (double-click it, or run from a terminal)
rem
rem - Already installed? Says so and exits.
rem - Tries winget first (the proper Windows install, gets updates).
rem - No winget? Downloads the official exe to %USERPROFILE%\.cloudflared\,
rem   which host-draft.bat checks automatically - no PATH changes needed.
rem
rem host-draft.bat does NOT require this - it can fetch its own private copy -
rem but a real install keeps cloudflared around for anything else.

setlocal

where cloudflared >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%v in ('cloudflared --version 2^>nul') do (
    echo [cloudflared] Already installed: %%v
    goto :done
  )
)

where winget >nul 2>nul
if not errorlevel 1 (
  echo [cloudflared] Installing via winget...
  winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements
  if not errorlevel 1 (
    echo [cloudflared] Installed. Open a NEW terminal for it to appear on PATH.
    goto :done
  )
  echo [cloudflared] winget install failed - falling back to a direct download.
)

where curl >nul 2>nul || (echo [cloudflared] curl is required - built into Windows 10 and newer & goto :faildone)

set "DEST_DIR=%USERPROFILE%\.cloudflared"
if not exist "%DEST_DIR%" mkdir "%DEST_DIR%"
echo [cloudflared] Downloading the official cloudflared binary...
curl -fSL -o "%DEST_DIR%\cloudflared.exe" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe || (echo [cloudflared] download failed & goto :faildone)

"%DEST_DIR%\cloudflared.exe" --version || (echo [cloudflared] downloaded binary does not run & goto :faildone)
echo [cloudflared] Installed to %DEST_DIR%\cloudflared.exe
echo [cloudflared] host-draft.bat will pick it up automatically.

:done
pause
exit /b 0

:faildone
pause
exit /b 1
