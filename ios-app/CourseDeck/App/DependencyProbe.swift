import Foundation

// Phase 0 dependency smoke test. Every package in project.yml is declared as a
// target dependency; importing each module here makes a broken product or a
// module-name mismatch fail the app build instead of the first feature use.
import Markdown
import SwiftSoup
import SwiftMath
import SwiftDraw
import Yams
import ZIPFoundation

enum DependencyProbe {
    static let linkedModules = [
        "Markdown (swift-markdown 0.7.1)",
        "cmark-gfm (swift-cmark 0.7.0)",
        "SwiftSoup 2.14.3",
        "SwiftMath 1.7.3",
        "ZIPFoundation 0.9.20",
        "Yams 6.2.2",
        "SwiftDraw 0.24.0",
    ]
}
