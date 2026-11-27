$ErrorActionPreference = 'Stop'

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    if (-not $env:SYNTEE_API_URL) { $env:SYNTEE_API_URL = 'https://syntee.fun' }
    if (-not $env:SYNTEE_WEB_URL) { $env:SYNTEE_WEB_URL = 'https://syntee.fun' }
    if (-not (Test-Path .\node_modules\electron\dist\electron.exe)) {
        node .\node_modules\electron\install.js
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    npm.cmd run build:sidecar
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $builderArgs = @('--win', '--x64', '--config', 'electron-builder.windows.yml')
    if ($env:SYNTEE_RELEASE_REPOSITORY -and $env:SYNTEE_RELEASE_REPOSITORY -ine 'Lun13371/SynteeAgentDesktop') {
        # Upgrade the fork's existing desktop install without sharing the legacy launcher's folder.
        $builderArgs += '--config.productName=Syntee Helper Desktop'
    }
    & .\node_modules\.bin\electron-builder.cmd @builderArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
