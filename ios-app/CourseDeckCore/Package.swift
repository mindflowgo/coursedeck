// swift-tools-version: 6.0
// CourseDeckCore — Foundation-only core for the CourseDeck iPad app.
//
// Toolchain contract (see ios-app/PLAN.md §2.2):
//   * tools 6.0 (Xcode 16.0 ships Swift 6.0.0)
//   * string platform initializers because `.v18` is absent from this PackageDescription
//   * Swift 5 language mode
//   * exact dependency pins; do not let swift-cmark float to 0.9.x

import PackageDescription

let package = Package(
    name: "CourseDeckCore",
    platforms: [
        .iOS("18.0"),
        .macOS("14.0"),
    ],
    products: [
        .library(name: "CourseDeckCore", targets: ["CourseDeckCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-markdown.git", exact: "0.7.1"),
        .package(url: "https://github.com/swiftlang/swift-cmark.git", exact: "0.7.0"),
        .package(url: "https://github.com/scinfu/SwiftSoup.git", exact: "2.14.3"),
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", exact: "0.9.20"),
        .package(url: "https://github.com/jpsim/Yams.git", exact: "6.2.2"),
        // SwiftMath 1.7.3 and SwiftDraw 0.24.0 are renderer-only dependencies
        // used by the app target and pinned in ios-app/project.yml. Core stays
        // Foundation-only.
    ],
    targets: [
        .target(
            name: "CourseDeckCore",
            dependencies: [
                .product(name: "Markdown", package: "swift-markdown"),
                .product(name: "SwiftSoup", package: "SwiftSoup"),
                .product(name: "ZIPFoundation", package: "ZIPFoundation"),
                .product(name: "Yams", package: "Yams"),
            ]
        ),
        .testTarget(
            name: "CourseDeckCoreTests",
            dependencies: [
                "CourseDeckCore",
                .product(name: "ZIPFoundation", package: "ZIPFoundation"),
            ],
            resources: [
                .copy("Fixtures"),
            ]
        ),
    ],
    swiftLanguageModes: [.v5]
)
