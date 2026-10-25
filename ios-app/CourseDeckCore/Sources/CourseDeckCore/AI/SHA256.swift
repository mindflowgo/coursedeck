import Foundation

/// Small, dependency-free SHA-256. Core is Foundation-only and prompt
/// provenance/manifest hashes must work without CryptoKit (PLAN §4.8).
public enum SHA256 {
    static let roundConstants: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    static let initialState: [UInt32] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]

    public static func digest(_ data: Data) -> [UInt8] {
        var state = initialState
        var message = [UInt8](data)
        let bitLength = UInt64(message.count) * 8
        message.append(0x80)
        while message.count % 64 != 56 {
            message.append(0)
        }
        for shift in stride(from: 56, through: 0, by: -8) {
            message.append(UInt8((bitLength >> UInt64(shift)) & 0xff))
        }
        for chunkStart in stride(from: 0, to: message.count, by: 64) {
            process(block: Array(message[chunkStart..<(chunkStart + 64)]), state: &state)
        }
        return encoded(state)
    }

    static func process(block: [UInt8], state: inout [UInt32]) {
        precondition(block.count == 64)
        var w = [UInt32](repeating: 0, count: 64)
        for index in 0..<16 {
            let offset = index * 4
            w[index] = (UInt32(block[offset]) << 24)
                | (UInt32(block[offset + 1]) << 16)
                | (UInt32(block[offset + 2]) << 8)
                | UInt32(block[offset + 3])
        }
        for index in 16..<64 {
            let s0 = rotateRight(w[index - 15], 7) ^ rotateRight(w[index - 15], 18) ^ (w[index - 15] >> 3)
            let s1 = rotateRight(w[index - 2], 17) ^ rotateRight(w[index - 2], 19) ^ (w[index - 2] >> 10)
            w[index] = w[index - 16] &+ s0 &+ w[index - 7] &+ s1
        }

        var a = state[0], b = state[1], c = state[2], d = state[3]
        var e = state[4], f = state[5], g = state[6], hh = state[7]

        for index in 0..<64 {
            let s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
            let ch = (e & f) ^ ((~e) & g)
            let temp1 = hh &+ s1 &+ ch &+ roundConstants[index] &+ w[index]
            let s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
            let maj = (a & b) ^ (a & c) ^ (b & c)
            let temp2 = s0 &+ maj

            hh = g
            g = f
            f = e
            e = d &+ temp1
            d = c
            c = b
            b = a
            a = temp1 &+ temp2
        }

        state[0] = state[0] &+ a
        state[1] = state[1] &+ b
        state[2] = state[2] &+ c
        state[3] = state[3] &+ d
        state[4] = state[4] &+ e
        state[5] = state[5] &+ f
        state[6] = state[6] &+ g
        state[7] = state[7] &+ hh
    }

    static func encoded(_ state: [UInt32]) -> [UInt8] {
        var output: [UInt8] = []
        output.reserveCapacity(32)
        for value in state {
            output.append(UInt8((value >> 24) & 0xff))
            output.append(UInt8((value >> 16) & 0xff))
            output.append(UInt8((value >> 8) & 0xff))
            output.append(UInt8(value & 0xff))
        }
        return output
    }

    public static func hex(_ data: Data) -> String {
        digest(data).map { String(format: "%02x", $0) }.joined()
    }

    public static func hex(_ string: String) -> String {
        hex(Data(string.utf8))
    }

    static func rotateRight(_ value: UInt32, _ count: UInt32) -> UInt32 {
        (value >> count) | (value << (32 - count))
    }
}

/// Incremental SHA-256 for streaming a package copy without loading the whole
/// file into memory (PLAN §4.11).
public struct SHA256Hasher: Sendable {
    private var state = SHA256.initialState
    private var buffer: [UInt8] = []
    private var totalBytes: UInt64 = 0

    public init() {}

    public mutating func update(_ data: Data) {
        totalBytes += UInt64(data.count)
        buffer.append(contentsOf: data)
        var consumed = 0
        while buffer.count - consumed >= 64 {
            SHA256.process(
                block: Array(buffer[consumed..<(consumed + 64)]),
                state: &state
            )
            consumed += 64
        }
        if consumed > 0 {
            buffer.removeFirst(consumed)
        }
    }

    public mutating func finalize() -> [UInt8] {
        var message = buffer
        let bitLength = totalBytes * 8
        message.append(0x80)
        while message.count % 64 != 56 {
            message.append(0)
        }
        for shift in stride(from: 56, through: 0, by: -8) {
            message.append(UInt8((bitLength >> UInt64(shift)) & 0xff))
        }
        var finalState = state
        for chunkStart in stride(from: 0, to: message.count, by: 64) {
            SHA256.process(
                block: Array(message[chunkStart..<(chunkStart + 64)]),
                state: &finalState
            )
        }
        return SHA256.encoded(finalState)
    }

    public mutating func finalizeHex() -> String {
        finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Streams a file through the hasher without materializing it.
    public static func hex(fileAt url: URL, chunkSize: Int = 256 * 1024) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256Hasher()
        while let chunk = try handle.read(upToCount: chunkSize), !chunk.isEmpty {
            hasher.update(chunk)
        }
        return hasher.finalizeHex()
    }
}
