@echo off
rem Host a draft over a Cloudflare quick tunnel on Windows - one shareable URL.
rem
rem   host-draft.bat        (double-click it, or run from a terminal)
rem
rem Runs the relay server (serves the app AND relays draft messages over
rem WebSockets - works under any NAT/VPN/CGNAT), opens one Cloudflare quick
rem tunnel in front of it, and prints the URL you AND your friends open.
rem The tunnel URL is random and changes on every run.
rem
rem Requirements: node + npm, curl (built into Windows 10+). cloudflared is
rem used from PATH if installed (install-cloudflared.bat sets that up),
rem otherwise a copy is downloaded to .cache\ on first run.
rem
rem Set PORT before running to change the port (default 8000).

setlocal enabledelayedexpansion
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8000

where node >nul 2>nul || (echo [draft] node is required - install it from https://nodejs.org & goto :fail)
where npm  >nul 2>nul || (echo [draft] npm is required - it comes with node & goto :fail)
where curl >nul 2>nul || (echo [draft] curl is required - built into Windows 10 and newer & goto :fail)

if not exist node_modules\ws (
  echo [draft] Installing dependencies - first run only...
  call npm install --no-audit --no-fund >nul || (echo [draft] npm install failed & goto :fail)
)
if not exist .cache mkdir .cache

rem ---------- cloudflared: PATH, the installer's location, or download ----------
set "CLOUDFLARED=cloudflared"
where cloudflared >nul 2>nul && goto :have_cf
if exist "%USERPROFILE%\.cloudflared\cloudflared.exe" (
  set "CLOUDFLARED=%USERPROFILE%\.cloudflared\cloudflared.exe"
  goto :have_cf
)
set "CLOUDFLARED=.cache\cloudflared.exe"
if exist .cache\cloudflared.exe goto :have_cf
echo [draft] Downloading cloudflared - first run only...
curl -fSL -o .cache\cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe || (echo [draft] cloudflared download failed & goto :fail)
:have_cf

rem ---------- relay server (serves the app + relays draft messages) ----------
echo [draft] Starting relay server on 127.0.0.1:%PORT%
start "mtgdraft-relay" /min cmd /c "node relay-server.mjs --port %PORT% --host 127.0.0.1 > .cache\relay.log 2>&1"

set RELAY_UP=
for /l %%i in (1,1,30) do (
  if not defined RELAY_UP (
    curl -fsS http://127.0.0.1:%PORT%/ >nul 2>nul && set RELAY_UP=1
    if not defined RELAY_UP ping -n 2 127.0.0.1 >nul
  )
)
if not defined RELAY_UP (echo [draft] Relay server did not start - see .cache\relay.log & goto :stop)
echo [draft] Relay server up.

rem ---------- tunnel ----------
if exist .cache\tunnel.log del .cache\tunnel.log
echo [draft] Opening Cloudflare quick tunnel - takes ~15s...
start "mtgdraft-tunnel" /min cmd /c ""%CLOUDFLARED%" tunnel --no-autoupdate --url http://127.0.0.1:%PORT% > .cache\tunnel.log 2>&1"

set WEB_URL=
for /l %%i in (1,1,60) do (
  if not defined WEB_URL (
    if exist .cache\tunnel.log (
      for /f "usebackq delims=" %%u in (`powershell -NoProfile -Command "$t=[IO.File]::ReadAllText('.cache/tunnel.log'); $m=[regex]::Match($t,'https://[a-z0-9-]+\.trycloudflare\.com'); if($m.Success){$m.Value}"`) do set "WEB_URL=%%u"
    )
    if not defined WEB_URL ping -n 2 127.0.0.1 >nul
  )
)
if not defined WEB_URL (echo [draft] Tunnel failed to open - see .cache\tunnel.log & goto :stop)

echo.
echo [draft] READY - open this URL yourself AND send it to your friends:
echo.
echo     !WEB_URL!/?relay=1
echo.
echo [draft] Everyone uses that same link. Create a room, share the 5-letter code.
echo [draft] Keep this window open for the whole draft.
echo [draft] Press any key here to stop hosting.
pause >nul

:stop
echo [draft] Shutting down...
taskkill /f /t /fi "WINDOWTITLE eq mtgdraft-relay*" >nul 2>nul
taskkill /f /t /fi "WINDOWTITLE eq mtgdraft-tunnel*" >nul 2>nul
exit /b 0

:fail
pause
exit /b 1
