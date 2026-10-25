#!/usr/bin/env bash
# Remote build helper for CourseDeck. Runs inside the existing macOS builder.
# Invoked by scripts/build-ipa.ps1 and scripts/run-core-tests.ps1.
#
# It never upgrades Xcode, resizes the container, or installs simulator runtimes.
# Usage: bash scripts/remote-build.sh [--toolchain-only|--core-tests-only|
#          --generate-only|--list-only|--archive-only|--all]

set -euo pipefail

WORKSPACE="${WORKSPACE:-$HOME/workspace/coursedeck-ios}"
MODE="${1:---all}"

print_toolchain() {
    local sdk version
    echo "=== Toolchain ==="
    sw_vers
    xcodebuild -version
    sdk="$(xcrun --sdk iphoneos --show-sdk-version | tr -d '\r')"
    echo "iOS SDK: $sdk"
    df -h /
    version="$(xcodebuild -version | awk '/^Xcode /{print $2; exit}')"
    case "$version" in
        16.*) ;;
        *) echo "ERROR: expected Xcode 16.x, found '$version'. Do not upgrade the builder." >&2; exit 1 ;;
    esac
    if [ "$sdk" != "18.0" ]; then
        echo "ERROR: expected iOS SDK 18.0, found '$sdk'. Do not upgrade the builder." >&2
        exit 1
    fi
}

run_core_tests() {
    echo "=== CourseDeckCore tests ==="
    (
        cd "$WORKSPACE/CourseDeckCore"
        swift --version
        swift package resolve
        swift test
    )
}

generate_project() {
    echo "=== Generate project ==="
    cd "$WORKSPACE"
    command -v xcodegen >/dev/null 2>&1 || { echo "ERROR: xcodegen is not installed in the builder." >&2; exit 127; }
    xcodegen generate

    if [ -f Package.resolved ]; then
        mkdir -p CourseDeck.xcodeproj/project.xcworkspace/xcshareddata/swiftpm
        cp Package.resolved CourseDeck.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
        echo "Copied committed Package.resolved into the generated workspace."
    else
        echo "WARNING: no committed Package.resolved; Xcode will resolve packages fresh." >&2
    fi
}

list_schemes() {
    echo "=== Schemes ==="
    cd "$WORKSPACE"
    xcodebuild -list -project CourseDeck.xcodeproj | tee /tmp/coursedeck-xcode-list.txt
    if ! sed -n '/Schemes:/,$p' /tmp/coursedeck-xcode-list.txt | grep -qE '^[[:space:]]+CourseDeck[[:space:]]*$'; then
        echo "ERROR: CourseDeck scheme is missing from xcodebuild -list." >&2
        exit 1
    fi
}

archive_and_package() {
    echo "=== Archive ==="
    cd "$WORKSPACE"
    xcodebuild clean archive \
        -project CourseDeck.xcodeproj \
        -scheme CourseDeck \
        -destination 'generic/platform=iOS' \
        -configuration Release \
        -archivePath build/CourseDeck.xcarchive \
        CODE_SIGN_IDENTITY='' \
        CODE_SIGNING_REQUIRED=NO \
        CODE_SIGNING_ALLOWED=NO

    cd build
    rm -rf Payload CourseDeck.ipa
    mkdir -p Payload
    cp -R CourseDeck.xcarchive/Products/Applications/CourseDeck.app Payload/
    zip -qry CourseDeck.ipa Payload

    unzip -p CourseDeck.ipa Payload/CourseDeck.app/Info.plist > /tmp/coursedeck-ipa-info.plist
    local min_os dtsdk
    min_os="$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' /tmp/coursedeck-ipa-info.plist | tr -d '\r')"
    dtsdk="$(/usr/libexec/PlistBuddy -c 'Print :DTSDKName' /tmp/coursedeck-ipa-info.plist | tr -d '\r')"
    echo "IPA MinimumOSVersion=$min_os DTSDKName=$dtsdk"
    if [ "$min_os" != "18.0" ]; then
        echo "ERROR: expected MinimumOSVersion 18.0, found '$min_os'." >&2
        exit 1
    fi
    if [ "$dtsdk" != "iphoneos18.0" ]; then
        echo "ERROR: expected DTSDKName iphoneos18.0, found '$dtsdk'." >&2
        exit 1
    fi
    echo "IPA metadata OK"
}

case "$MODE" in
    --toolchain-only)
        print_toolchain
        ;;
    --core-tests-only)
        print_toolchain
        run_core_tests
        ;;
    --generate-only)
        print_toolchain
        generate_project
        ;;
    --list-only)
        list_schemes
        ;;
    --archive-only)
        archive_and_package
        ;;
    --all)
        print_toolchain
        run_core_tests
        generate_project
        list_schemes
        archive_and_package
        ;;
    *)
        echo "Usage: $0 [--toolchain-only|--core-tests-only|--generate-only|--list-only|--archive-only|--all]" >&2
        exit 2
        ;;
esac
