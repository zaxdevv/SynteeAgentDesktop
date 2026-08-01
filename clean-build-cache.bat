@echo off
chcp 65001 >nul 2>&1
title Syntee Helper - Clean Build Caches
color 0E

set CLIENT_DIR=C:\Projects\SynteeHelper

echo.
echo  ============================================================
echo             SYNTEE HELPER - CLEAN BUILD CACHES
echo  ============================================================
echo.
echo  Removes build artifacts and caches. Does NOT touch:
echo    node_modules (deps), src, resources, .git, logs
echo.
echo  Two groups:
echo    1. Build artifacts + local caches (fast to regenerate)
echo       out\, dist\, node_modules\.cache, node_modules\.vite,
echo       *.tsbuildinfo  (incl. obfuscated renderer + V8 bytecode .jsc)
echo.
echo    2. Download caches (force re-download on next build:win)
echo       %%LOCALAPPDATA%%\electron-builder\Cache  (electron + nsis)
echo       %%LOCALAPPDATA%%\electron\Cache          (electron binary)
echo       %%APPDATA%%\electron-builder\Cache
echo.

if not exist "%CLIENT_DIR%\package.json" (
    echo  [ERROR] Client not found: %CLIENT_DIR%\package.json
    pause
    exit /b 1
)

echo  ------------------------------------------------------------
echo  Group 1: Build artifacts + local caches
echo  ------------------------------------------------------------
echo.

set TOTAL1=0
call :CleanDir "%CLIENT_DIR%\out"            "out\ (electron-vite bundles + V8 bytecode + obfuscated renderer)"
call :CleanDir "%CLIENT_DIR%\dist"            "dist\ (electron-builder artifacts: win-unpacked, zip)"
call :CleanDir "%CLIENT_DIR%\node_modules\.cache" "node_modules\.cache (vite/babel/eslint cache)"
call :CleanDir "%CLIENT_DIR%\node_modules\.vite"  "node_modules\.vite (vite cache)"

echo.
echo  Cleaning TypeScript incremental caches (*.tsbuildinfo)...
set TSBC=0
for %%f in ("%CLIENT_DIR%\*.tsbuildinfo") do (
    echo   - %%~nxf  (%%~zf bytes)
    set /a TSBC+=1
    del /q "%%f"
)
if %TSBC%==0 echo   (none found)

echo.
echo  ------------------------------------------------------------
echo  Group 2: Download caches (force re-download on next build)
echo  ------------------------------------------------------------
echo.
echo  These keep downloaded electron binaries / nsis tools so
echo  build:win doesn't re-download each time. Removing them frees
echo  disk space but the NEXT build:win will re-download (~hundreds MB).
echo.
set /p CONFIRM="  Clean download caches too? [y/N]: "
if /i not "%CONFIRM%"=="y" goto :skipDownloads

echo.
call :CleanDir "%LOCALAPPDATA%\electron-builder\Cache" "%%LOCALAPPDATA%%\electron-builder\Cache"
call :CleanDir "%APPDATA%\electron-builder\Cache"      "%%APPDATA%%\electron-builder\Cache"
call :CleanDir "%LOCALAPPDATA%\electron\Cache"         "%%LOCALAPPDATA%%\electron\Cache"
goto :done

:skipDownloads
echo  Skipped download caches.

:done
echo.
echo  ============================================================
echo                       CLEAN COMPLETE
echo  ============================================================
echo.
echo  Next build will regenerate out\ and local caches.
echo  If you cleaned download caches, build:win will re-download
echo  electron + nsis on first run.
echo.
pause
exit /b 0

REM ── subroutine: CleanDir "path" "label" ──
REM Computes size via PowerShell, prints it, removes the dir.
:CleanDir
set "D=%~1"
set "L=%~2"
if not exist "%D%" (
    echo  [skip] %L%  - not present
    goto :eof
)
for /f "delims=" %%s in ('powershell -NoProfile -Command "$p='%D%'; if(Test-Path $p){ $sum=(Get-ChildItem -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; if($sum){[math]::Round($sum/1MB,1).ToString()} else {'0'} } else {'0'}"') do set SZ=%%s
echo  [del]  %L%  (%SZ% MB)
rmdir /s /q "%D%" 2>nul
if exist "%D%" (
    echo        [WARNING] could not fully remove - file may be locked
) else (
    echo        [OK] removed
)
goto :eof
