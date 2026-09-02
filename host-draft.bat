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
rem Missing anything? This script runs install-dependencies.bat by itself
rem (portable Node.js + cloudflared, no Microsoft Store / winget / admin).
rem Needs curl, which is built into Windows 10 and newer.
rem
rem Set PORT before running to change the port (default 8000).

setlocal
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8000

where curl >nul 2>nul
if errorlevel 1 (
  echo [draft] curl is required - it is built into Windows 10 and newer.
  goto :fail
)

rem ---------- node: PATH, portable install, or run the installer ----------
set "NODE_EXE=node"
set "NPM_CMD=npm"
where node >nul 2>nul
if not errorlevel 1 goto :node_ready
set "NODE_EXE=%USERPROFILE%\.mtgdraft\node\node.exe"
set "NPM_CMD=%USERPROFILE%\.mtgdraft\node\npm.cmd"
if exist "%NODE_EXE%" goto :node_ready
echo [draft] Node.js not found - installing dependencies first...
call install-dependencies.bat auto
if errorlevel 1 goto :fail
where node >nul 2>nul
if not errorlevel 1 goto :node_on_path
if exist "%NODE_EXE%" goto :node_ready
echo [draft] Node.js still missing after install - see the messages above.
goto :fail
:node_on_path
set "NODE_EXE=node"
set "NPM_CMD=npm"
:node_ready

if not exist node_modules\ws (
  echo [draft] Installing relay server packages - first run only...
  call "%NPM_CMD%" install --no-audit --no-fund >nul
  if errorlevel 1 (
    echo [draft] npm install failed.
    goto :fail
  )
)
if not exist .cache mkdir .cache

rem ---------- cloudflared: PATH, the installer's location, or download ----------
set "CLOUDFLARED=cloudflared"
where cloudflared >nul 2>nul
if not errorlevel 1 goto :cf_ready
set "CLOUDFLARED=%USERPROFILE%\.cloudflared\cloudflared.exe"
if exist "%CLOUDFLARED%" goto :cf_ready
set "CLOUDFLARED=.cache\cloudflared.exe"
if exist "%CLOUDFLARED%" goto :cf_ready
echo [draft] Downloading cloudflared - first run only...
curl -fSL -o .cache\cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
if errorlevel 1 (
  echo [draft] cloudflared download failed.
  goto :fail
)
:cf_ready

rem ---------- relay server (serves the app + relays draft messages) ----------
echo [draft] Starting relay server on 127.0.0.1:%PORT%
start "mtgdraft-relay" /min cmd /c ""%NODE_EXE%" relay-server.mjs --port %PORT% --host 127.0.0.1 > .cache\relay.log 2>&1"

set RELAY_TRIES=0
:wait_relay
set /a RELAY_TRIES+=1
curl -fsS http://127.0.0.1:%PORT%/ >nul 2>nul
if not errorlevel 1 goto :relay_up
if %RELAY_TRIES% geq 30 goto :relay_dead
ping -n 2 127.0.0.1 >nul
goto :wait_relay

:relay_dead
echo [draft] Relay server did not start. Its log says:
type .cache\relay.log 2>nul
goto :stopfail

:relay_up
echo [draft] Relay server up.

rem ---------- tunnel ----------
if exist .cache\tunnel.log del .cache\tunnel.log
if exist .cache\weburl.tmp del .cache\weburl.tmp
echo [draft] Opening Cloudflare quick tunnel - takes ~15s...
start "mtgdraft-tunnel" /min cmd /c ""%CLOUDFLARED%" tunnel --no-autoupdate --url http://127.0.0.1:%PORT% > .cache\tunnel.log 2>&1"

set WEB_URL=
set TUNNEL_TRIES=0
:wait_tunnel
set /a TUNNEL_TRIES+=1
if not exist .cache\tunnel.log goto :tunnel_sleep
powershell -NoProfile -Command "$t=[IO.File]::ReadAllText('.cache/tunnel.log'); $m=[regex]::Match($t,'https://[a-z0-9-]+\.trycloudflare\.com'); if($m.Success){[IO.File]::WriteAllText('.cache/weburl.tmp',$m.Value)}" >nul 2>nul
if exist .cache\weburl.tmp set /p WEB_URL=<.cache\weburl.tmp
if defined WEB_URL goto :have_url
:tunnel_sleep
if %TUNNEL_TRIES% geq 60 goto :tunnel_dead
ping -n 2 127.0.0.1 >nul
goto :wait_tunnel

:tunnel_dead
echo [draft] Tunnel failed to open. Its log says:
type .cache\tunnel.log 2>nul
goto :stopfail

:have_url
echo.
echo [draft] READY - open this URL yourself AND send it to your friends:
echo.
echo     %WEB_URL%/?relay=1
echo.
echo [draft] Everyone uses that same link. Create a room, share the 5-letter code.
echo [draft] Keep this window open for the whole draft.
echo [draft] Press any key here to stop hosting.
pause >nul

echo [draft] Shutting down...
taskkill /f /t /fi "WINDOWTITLE eq mtgdraft-relay*" >nul 2>nul
taskkill /f /t /fi "WINDOWTITLE eq mtgdraft-tunnel*" >nul 2>nul
exit /b 0

:stopfail
taskkill /f /t /fi "WINDOWTITLE eq mtgdraft-relay*" >nul 2>nul
taskkill /f /t /fi "WINDOWTITLE eq mtgdraft-tunnel*" >nul 2>nul
:fail
echo.
echo [draft] Something went wrong - the messages above say what.
pause
exit /b 1
