@echo off
cd /d C:\Projects\SynteeHelper
echo Building Syntee Helper (debug + guard)...

REM ── Syntee-Gateway endpoints (dev) ──
REM API_URL — куда main-процесс стучится за /v1/* и /api/user/* (backend FastAPI).
REM WEB_URL — сайт gateway, где открывается consent-страница /auth/desktop.
set SYNTEE_API_URL=http://localhost:8000
set SYNTEE_WEB_URL=http://localhost:3000

REM ── Source protection ON (как в build-release.bat) ──
REM V8 bytecode для main/preload + javascript-obfuscator для renderer.
REM Проверяем, что защита ничего не ломает в рантайме, БЕЗ упаковки в exe
REM (electron-builder не запускаем — собираем только бандл и стартуем electron).
set SYNTEE_PROTECT=1

call node node_modules/electron-vite/bin/electron-vite.js build
if %errorlevel% neq 0 (
    echo BUILD FAILED
    pause
    exit /b 1
)

echo.
echo Verifying source protection (V8 bytecode)...
if exist "out\main\index.jsc" (
    echo  [OK] V8 bytecode applied: out\main\*.jsc
) else (
    echo  [WARNING] out\main\index.jsc not found - protection may be OFF!
)

echo.
echo ============================================
echo  SYNTEE DEBUG-GUARD — логи main/worker ниже
echo  API:    %SYNTEE_API_URL%
echo  WEB:    %SYNTEE_WEB_URL%
echo  GUARD:  SYNTEE_PROTECT=1 (bytecode + obfuscator)
echo ============================================
echo.
node_modules\electron\dist\electron.exe out\main\index.js --enable-logging 2>&1
pause
