import Foundation

/// One spoken unit sent by the web app: a chapter title or a paragraph.
struct SpeechSegment: Decodable, Equatable {
    let text: String
    let chapterTitle: String
    let chapterIndex: Int
    /// Where the paragraph is in the book (blockIndex -1 is the chapter title),
    /// so a note added through Siri lands here. Older web builds don't send them.
    var chapterId: String? = nil
    var blockIndex: Int? = nil
    /// The paragraph split by voice when some dialogue has a character's own
    /// Microsoft voice (`voiceId` nil = the narration voice); the parts' text
    /// joins to `text`. Older web builds don't send it.
    var parts: [VoicedPart]? = nil
}

/// A run of a paragraph read in one voice.
struct VoicedPart: Decodable, Equatable {
    let text: String
    /// A web voice id ("azure:<short name>"), or nil for the narration voice.
    var voiceId: String? = nil
    /// Speed relative to the reader's; nil = 1 for a character's voice, the
    /// narration speed for the narration voice.
    var rate: Double? = nil
}

/// What `window.quillNative.speech.play()` sends.
struct SpeechPlayRequest: Decodable {
    let segments: [SpeechSegment]
    let startIndex: Int
    let voiceId: String?
    let rate: Double
    /// Narration's speed relative to `rate` (the narrator's own speed). Older web builds don't send it.
    var narrationRate: Double? = nil
    let bookTitle: String
    /// The book being read, when it's a whole book.
    var bookId: String? = nil
}

/// Pure timing and navigation math for the read-aloud queue. Speech has no real
/// duration, so the lock screen / CarPlay scrubber uses an estimate from text length.
struct SpeechTimeline {
    /// Roughly 170 words a minute at normal speed.
    static let charactersPerSecond = 14.5

    let segments: [SpeechSegment]
    /// The web app's speed (1 = normal).
    let rate: Double

    /// Estimated start time of each segment, plus the total at the end.
    private var starts: [Double] {
        var out: [Double] = [0]
        out.reserveCapacity(segments.count + 1)
        for seg in segments { out.append(out.last! + seconds(for: seg)) }
        return out
    }

    func seconds(for segment: SpeechSegment) -> Double {
        max(1, Double(segment.text.count) / (Self.charactersPerSecond * max(rate, 0.1)))
    }

    var duration: Double { starts.last ?? 0 }

    func startTime(of index: Int) -> Double {
        let s = starts
        return s[min(max(index, 0), s.count - 1)]
    }

    /// The segment playing at `time` seconds into the queue.
    func index(at time: Double) -> Int {
        guard !segments.isEmpty else { return 0 }
        let s = starts
        var i = 0
        while i + 1 < segments.count && s[i + 1] <= time { i += 1 }
        return i
    }

    /// Where a ±seconds skip lands; always moves at least one segment forward.
    func skip(from index: Int, elapsedInSegment: Double, by seconds: Double) -> Int {
        let target = startTime(of: index) + elapsedInSegment + seconds
        let landed = self.index(at: max(0, target))
        if seconds > 0 && landed <= index { return min(index + 1, segments.count - 1) }
        return landed
    }

    /// First segment of the next chapter, or nil in the last chapter.
    func nextChapterStart(from index: Int) -> Int? {
        guard segments.indices.contains(index) else { return nil }
        let chapter = segments[index].chapterIndex
        return segments.indices.first { $0 > index && segments[$0].chapterIndex != chapter }
    }

    /// Restarts this chapter, or goes back one when already at (or just past) its start.
    func previousChapterStart(from index: Int) -> Int {
        guard segments.indices.contains(index) else { return 0 }
        let chapter = segments[index].chapterIndex
        let start = segments.firstIndex { $0.chapterIndex == chapter } ?? 0
        if index - start > 1 || chapter == 0 { return start }
        return segments.firstIndex { $0.chapterIndex == chapter - 1 } ?? start
    }

    var chapterCount: Int { (segments.last?.chapterIndex ?? -1) + 1 }

    /// Maps the web speed (1 = normal) onto AVSpeechUtterance's 0…1 scale, where
    /// 0.5 is normal and the scale is steeper above it.
    static func utteranceRate(for rate: Double, defaultRate: Float = 0.5, min minRate: Float = 0, max maxRate: Float = 1) -> Float {
        let r = Float(rate)
        let mapped = r >= 1 ? defaultRate + (r - 1) * 0.2 : defaultRate * r
        return Swift.min(Swift.max(mapped, minRate), maxRate)
    }
}

/// Leading audio to drop while re-rendering a paragraph to resume partway
/// through it: takes from each rendered buffer in turn until it's used up.
struct FrameSkip: Equatable {
    private(set) var remaining: Int64

    init(frames: Int64) { remaining = max(0, frames) }

    /// How many of the next buffer's `length` frames to drop.
    mutating func take(_ length: Int64) -> Int64 {
        let drop = min(remaining, max(0, length))
        remaining -= drop
        return drop
    }
}

/// Where each word of a paragraph starts in its rendered audio, from the
/// synthesizer's word markers, so the player can tell which word is being
/// spoken at a given point.
struct WordTimeline: Equatable {
    struct Mark: Equatable {
        /// Byte offset into the paragraph's audio, as the synthesizer reports it.
        let byteOffset: Int
        /// The word's UTF-16 range in the paragraph text.
        let location: Int
        let length: Int
    }

    private(set) var marks: [Mark] = []

    mutating func add(_ mark: Mark) {
        // Markers arrive in order; keep them sorted in case a batch doesn't.
        if let last = marks.last, last.byteOffset > mark.byteOffset {
            marks.append(mark)
            marks.sort { $0.byteOffset < $1.byteOffset }
        } else {
            marks.append(mark)
        }
    }

    /// The word being spoken `frame` frames into the paragraph (the last one
    /// that has started), given the audio's bytes per frame; nil before the
    /// first word or when there are no markers.
    func word(atFrame frame: Int64, bytesPerFrame: Int) -> Mark? {
        guard bytesPerFrame > 0 else { return nil }
        let byte = frame * Int64(bytesPerFrame)
        return marks.last { Int64($0.byteOffset) <= byte }
    }

    /// Where `mark` starts, in frames.
    static func startFrame(of mark: Mark, bytesPerFrame: Int) -> Int64 {
        bytesPerFrame > 0 ? Int64(mark.byteOffset / bytesPerFrame) : 0
    }
}
