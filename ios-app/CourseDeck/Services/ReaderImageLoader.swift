import CourseDeckCore
import Foundation
import SwiftDraw
import UIKit

struct ReaderLoadedImage {
    var image: UIImage
    var isSVG: Bool
}

struct ReaderImageLoadResult {
    var loaded: ReaderLoadedImage?
    var failure: String?
    var isRemoteBlocked: Bool

    static func failed(_ message: String) -> ReaderImageLoadResult {
        ReaderImageLoadResult(loaded: nil, failure: message, isRemoteBlocked: false)
    }
}

/// Disk image loader with downsampling and SVG rasterization. Remote images
/// are never fetched unless the caller explicitly opts in (the reader shows a
/// placeholder and asks for confirmation first).
final class ReaderImageLoader {
    static let shared = ReaderImageLoader()

    private let cache = NSCache<NSString, UIImage>()
    private let queue = DispatchQueue(
        label: "com.ilc.coursedeck.reader.images",
        qos: .userInitiated
    )

    private init() {
        cache.countLimit = 160
        cache.totalCostLimit = 96 * 1024 * 1024
    }

    func load(
        destination: String,
        courseDirectoryURL: URL,
        maxPixelSize: CGFloat,
        scale: CGFloat,
        allowsRemote: Bool = false
    ) async -> ReaderImageLoadResult {
        let trimmed = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failed("Missing image source") }

        if let url = URL(string: trimmed), url.scheme?.lowercased() == "http" || url.scheme?.lowercased() == "https" {
            guard allowsRemote else {
                return ReaderImageLoadResult(loaded: nil, failure: "Remote image blocked", isRemoteBlocked: true)
            }
            return await loadRemote(url: url, maxPixelSize: maxPixelSize, scale: scale)
        }

        guard let fileURL = resolveFileURL(trimmed, courseDirectoryURL: courseDirectoryURL) else {
            return .failed("Image path is outside the course assets folder")
        }
        let key = "\(fileURL.path)|\(Int(maxPixelSize))|\(Int(scale * 100))" as NSString
        if let cached = cache.object(forKey: key) {
            return ReaderImageLoadResult(
                loaded: ReaderLoadedImage(image: cached, isSVG: fileURL.pathExtension.lowercased() == "svg"),
                failure: nil,
                isRemoteBlocked: false
            )
        }

        return await withCheckedContinuation { continuation in
            queue.async {
                let result = Self.loadFile(
                    url: fileURL,
                    maxPixelSize: maxPixelSize,
                    scale: scale
                )
                if let image = result.loaded?.image {
                    let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
                    self.cache.setObject(image, forKey: key, cost: cost)
                }
                continuation.resume(returning: result)
            }
        }
    }

    /// Synchronous file/SVG load used by the table/prepare pipeline when it has
    /// already been scheduled on a background queue.
    static func loadFile(url: URL, maxPixelSize: CGFloat, scale: CGFloat) -> ReaderImageLoadResult {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return .failed("Image not found")
        }
        if url.pathExtension.lowercased() == "svg" {
            guard let data = try? Data(contentsOf: url),
                  let svgText = Self.repairedSVGData(data),
                  let svg = SVG(data: svgText) else {
                return .failed("SVG could not be decoded")
            }
            let natural = svg.size
            guard natural.width > 0, natural.height > 0 else {
                return .failed("SVG has no size")
            }
            let factor = min(maxPixelSize / max(natural.width, natural.height), 4)
            let target = CGSize(
                width: max(1, natural.width * max(factor, 0.25)),
                height: max(1, natural.height * max(factor, 0.25))
            )
            let image = svg.rasterize(size: target, scale: max(scale, 1))
            return ReaderImageLoadResult(
                loaded: ReaderLoadedImage(image: image, isSVG: true),
                failure: nil,
                isRemoteBlocked: false
            )
        }

        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            return .failed("Image could not be read")
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, Int(maxPixelSize)),
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return .failed("Image could not be downsampled")
        }
        let image = UIImage(cgImage: cgImage, scale: max(scale, 1), orientation: .up)
        return ReaderImageLoadResult(
            loaded: ReaderLoadedImage(image: image, isSVG: false),
            failure: nil,
            isRemoteBlocked: false
        )
    }

    private func loadRemote(url: URL, maxPixelSize: CGFloat, scale: CGFloat) async -> ReaderImageLoadResult {
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                return .failed("Remote image returned HTTP \(http.statusCode)")
            }
            let key = "remote|\(url.absoluteString)|\(Int(maxPixelSize))" as NSString
            if let cached = cache.object(forKey: key) {
                return ReaderImageLoadResult(
                    loaded: ReaderLoadedImage(image: cached, isSVG: false),
                    failure: nil,
                    isRemoteBlocked: false
                )
            }
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
                return .failed("Remote image could not be decoded")
            }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: max(1, Int(maxPixelSize)),
            ]
            guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
                return .failed("Remote image could not be downsampled")
            }
            let image = UIImage(cgImage: cgImage, scale: max(scale, 1), orientation: .up)
            cache.setObject(image, forKey: key)
            return ReaderImageLoadResult(
                loaded: ReaderLoadedImage(image: image, isSVG: false),
                failure: nil,
                isRemoteBlocked: false
            )
        } catch {
            return .failed("Remote image failed: \(error.localizedDescription)")
        }
    }

    private func resolveFileURL(_ destination: String, courseDirectoryURL: URL) -> URL? {
        if let url = URL(string: destination), url.isFileURL {
            return url
        }
        var candidate = destination
        while candidate.hasPrefix("../") {
            candidate.removeFirst(3)
        }
        while candidate.hasPrefix("./") {
            candidate.removeFirst(2)
        }
        let relative: String
        if candidate.hasPrefix("assets/") {
            relative = String(candidate.dropFirst("assets/".count))
        } else {
            return nil
        }
        return try? PathValidator.safeJoin(
            base: courseDirectoryURL,
            components: ["assets"] + relative.split(separator: "/").map(String.init)
        )
    }

    /// Some BAF3M icons were captured as quoted-printable text and contain
    /// literal `=3D` instead of `=`. `SVGRepair` is shared with ingestion so a
    /// repaired icon is identical on both paths; SwiftDraw then renders it.
    static func repairedSVGData(_ data: Data) -> Data? {
        guard String(data: data, encoding: .utf8) != nil else { return nil }
        return SVGRepair.repair(data)
    }
}
