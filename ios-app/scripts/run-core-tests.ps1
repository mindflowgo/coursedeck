# run-core-tests.ps1
# Runs CourseDeckCore's Foundation-only test suite on the existing macOS builder.
# No simulator runtime is required or downloaded.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\run-core-tests.ps1

[CmdletBinding()]
param(
    [string]$MacHost = "127.0.0.1",
    [int]$MacPort = 2222,
    [string]$MacUser = "builder",
    [string]$MacPass = "builder",
    [string]$RemoteWorkspace = "",
    [string]$WinProject = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($WinProject)) {
    $WinProject = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
}

if ([string]::IsNullOrWhiteSpace($RemoteWorkspace)) {
    $RemoteWorkspace = "/Users/$MacUser/workspace/coursedeck-ios"
}

function ConvertTo-WslPath {
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path).Replace('\', '/')
    if ($full -match '^([A-Za-z]):/(.*)$') {
        return "/mnt/" + $Matches[1].ToLowerInvariant() + "/" + $Matches[2]
    }
    return $full
}

function Invoke-WslBash {
    param([string]$Command)
    $output = & wsl.exe -u root -d Ubuntu -e bash -c $Command
    $exitCode = $LASTEXITCODE
    if ($null -ne $output) { $output | Write-Output }
    if ($exitCode -ne 0) {
        throw "Command failed (exit $exitCode): $Command"
    }
}

function Invoke-Remote {
    param([string]$Command)
    $ssh = "sshpass -p '$MacPass' ssh -p $MacPort -o StrictHostKeyChecking=no " +
           "-o PreferredAuthentications=password -o PubkeyAuthentication=no " +
           "${MacUser}@${MacHost} $Command"
    Invoke-WslBash -Command $ssh
}

Write-Host "Running CourseDeckCore tests on the existing macOS builder..." -ForegroundColor Cyan

& docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is not running. Start Docker Desktop and the macos-builder container first."
}
$runningContainers = & docker ps --format "{{.Names}}"
if (-not ($runningContainers -contains "macos-builder")) {
    throw "The macos-builder container is not running. Start the existing container and retry."
}

$osInfo = Invoke-Remote "sw_vers"
$xcodeInfo = Invoke-Remote "xcodebuild -version"
$sdkVersion = (Invoke-Remote "xcrun --sdk iphoneos --show-sdk-version" | Out-String).Trim()
Write-Host ((@($osInfo) + @($xcodeInfo) + @("iOS SDK: $sdkVersion")) -join "`n")

$wslSource = (ConvertTo-WslPath $WinProject) + "/"
$remoteDest = "${MacUser}@${MacHost}:$RemoteWorkspace/"
$rsync = "rsync -az --delete -e 'sshpass -p $MacPass ssh -p $MacPort " +
         "-o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no' " +
         "--exclude '.git' --exclude 'build' --exclude 'DerivedData' --exclude '*.xcodeproj' " +
         "--exclude '*.xcarchive' --exclude '*.ipa' --exclude '.swiftpm' --exclude '.build' " +
         "'$wslSource' '$remoteDest'"
Invoke-WslBash -Command $rsync

Write-Host "swift package resolve && swift test (CourseDeckCore)" -ForegroundColor Yellow
Invoke-Remote -Command "bash $RemoteWorkspace/scripts/remote-build.sh --core-tests-only"

Write-Host "CourseDeckCore tests passed." -ForegroundColor Green
