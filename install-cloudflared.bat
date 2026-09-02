@echo off
rem Install cloudflared (Cloudflare quick tunnel) on Windows if you don't have it.
rem
rem   install-cloudflared.bat    (double-click it, or run from a terminal)
rem
rem - Already installed? Says so and exits.
rem - Otherwise downloads the OFFICIAL exe straight from Cloudflare's GitHub
rem   releases into %USERPROFILE%\.cloudflared\, which host-draft.bat checks
rem   automatically. No Microsoft Store, no winget, no PATH changes - works
rem   on debloated Windows installs.
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
