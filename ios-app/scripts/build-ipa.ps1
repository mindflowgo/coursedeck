# build-ipa.ps1
# Builds CourseDeck into an unsigned IPA on the existing macOS builder.
#
# It does NOT upgrade Xcode, resize the builder, or change the container.
# It verifies Xcode 16.x + iOS 18.0 SDK before building and asserts the IPA
# metadata (MinimumOSVersion=18.0, DTSDKName=iphoneos18.0).
#
# Usage (PowerShell):
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-ipa.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-ipa.ps1 -SkipCoreTests

[CmdletBinding()]
param(
    [string]$MacHost = "127.0.0.1",
    [int]$MacPort = 2222,
    [string]$MacUser = "builder",
    [string]$MacPass = "builder",
    [string]$RemoteWorkspace = "",
    [string]$WinProject = "",
    [switch]$SkipCoreTests
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
        throw "Remote command failed (exit $exitCode): $Command"
    }
}

function Invoke-Remote {
    param([string]$Command)
    $ssh = "sshpass -p '$MacPass' ssh -p $MacPort -o StrictHostKeyChecking=no " +
           "-o PreferredAuthentications=password -o PubkeyAuthentication=no " +
           "${MacUser}@${MacHost} $Command"
    Invoke-WslBash -Command $ssh
}

$wslSource = (ConvertTo-WslPath $WinProject) + "/"
$remoteDest = "${MacUser}@${MacHost}:$RemoteWorkspace/"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Building CourseDeck unsigned IPA          " -ForegroundColor Cyan
Write-Host " iPadOS 18.0 / Xcode 16.0 / iOS 18.0 SDK   " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Preconditions ---------------------------------------------------------
Write-Host "[1/9] Checking Docker and the existing macos-builder container..." -ForegroundColor Yellow
& docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is not running. Start Docker Desktop and the macos-builder container first."
}
$runningContainers = & docker ps --format "{{.Names}}"
if (-not ($runningContainers -contains "macos-builder")) {
    throw "The macos-builder container is not running. Start the existing container (docker compose up -d) and retry. Do not recreate or resize it."
}

# 2. Verify toolchain (never upgrade) --------------------------------------
Write-Host "[2/9] Verifying toolchain inside the container..." -ForegroundColor Yellow
$osInfo = Invoke-Remote "sw_vers"
$xcodeInfo = Invoke-Remote "xcodebuild -version"
$sdkVersion = (Invoke-Remote "xcrun --sdk iphoneos --show-sdk-version" | Out-String).Trim()
$diskInfo = Invoke-Remote "df -h /"
$toolchainText = (@($osInfo) + @($xcodeInfo) + @("iOS SDK: $sdkVersion") + @($diskInfo)) -join "`n"
Write-Host $toolchainText
if ($toolchainText -notmatch "Xcode 16\.") {
    throw "Expected Xcode 16.x. Do not upgrade the builder; check the container toolchain."
}
if ($sdkVersion -ne "18.0") {
    throw "Expected the iOS 18.0 SDK, found '$sdkVersion'. Do not upgrade the builder; check the container toolchain."
}

# 3. Stage prompts before rsync -------------------------------------------
Write-Host "[3/9] Staging reviewed prompts..." -ForegroundColor Yellow
& (Join-Path $PSScriptRoot "stage-prompts.ps1")

# 4. Sync to the builder ---------------------------------------------------
Write-Host "[4/9] Syncing ios-app to $MacHost..." -ForegroundColor Yellow
$rsync = "rsync -az --delete -e 'sshpass -p $MacPass ssh -p $MacPort " +
         "-o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no' " +
         "--exclude '.git' --exclude 'build' --exclude 'DerivedData' --exclude '*.xcodeproj' " +
         "--exclude '*.xcarchive' --exclude '*.ipa' --exclude '.swiftpm' --exclude '.build' " +
         "'$wslSource' '$remoteDest'"
Invoke-WslBash -Command $rsync

# 5. Core tests ------------------------------------------------------------
if ($SkipCoreTests) {
    Write-Host "[5/9] Skipping CourseDeckCore tests (-SkipCoreTests)." -ForegroundColor DarkYellow
} else {
    Write-Host "[5/9] Running CourseDeckCore swift test..." -ForegroundColor Yellow
    Invoke-Remote -Command "bash $RemoteWorkspace/scripts/remote-build.sh --core-tests-only"
}

# 6. Generate project and seed the committed package lockfile --------------
Write-Host "[6/9] Generating Xcode project and seeding Package.resolved..." -ForegroundColor Yellow
Invoke-Remote -Command "bash $RemoteWorkspace/scripts/remote-build.sh --generate-only"

# 7. Assert the shared CourseDeck scheme ----------------------------------
Write-Host "[7/9] Verifying the CourseDeck scheme with xcodebuild -list..." -ForegroundColor Yellow
Invoke-Remote -Command "bash $RemoteWorkspace/scripts/remote-build.sh --list-only"

# 8. Archive and package the unsigned IPA ---------------------------------
Write-Host "[8/9] Archiving Release and packaging Payload/CourseDeck.ipa..." -ForegroundColor Yellow
Invoke-Remote -Command "bash $RemoteWorkspace/scripts/remote-build.sh --archive-only"

# 9. Pull the IPA back -----------------------------------------------------
Write-Host "[9/9] Pulling the unsigned IPA back to Windows..." -ForegroundColor Yellow
$wslDestination = ConvertTo-WslPath (Join-Path $WinProject "CourseDeck.ipa")
$scp = "sshpass -p '$MacPass' scp -P $MacPort -o StrictHostKeyChecking=no " +
       "-o PreferredAuthentications=password -o PubkeyAuthentication=no " +
       "${MacUser}@${MacHost}:$RemoteWorkspace/build/CourseDeck.ipa '$wslDestination'"
Invoke-WslBash -Command $scp

if (-not (Test-Path -LiteralPath (Join-Path $WinProject "CourseDeck.ipa"))) {
    throw "IPA was not copied back to $WinProject."
}

Write-Host "==========================================" -ForegroundColor Green
Write-Host " SUCCESS: unsigned IPA created            " -ForegroundColor Green
Write-Host " $(Join-Path $WinProject 'CourseDeck.ipa')" -ForegroundColor White
Write-Host " Next: install through iLoader on the iPad." -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
