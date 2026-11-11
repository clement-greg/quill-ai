import AVFoundation
import MediaPlayer
import UIKit
import os

private let log = Logger(subsystem: "com.elevatehomescriptions.quillai", category: "ReadAloud")

/// Reads the web app's queue aloud with the iPhone's own voices. Plays in the
/// background and publishes Now Playing info and remote commands, so the lock
/// screen, Control Center, AirPods, the steering wheel and CarPlay's Now Playing
/// screen can all control it.
@MainActor
final class SpeechController: NSObject {
    static let shared = SpeechController()

    enum State: String { case idle, playing, paused }

    /// Events for the web page: `["type": "progress", "index": n]`, `["type": "state", "state": …]`, `["type": "error", …]`.
    var onEvent: (([String: Any]) -> Void)?

    private let synth = AVSpeechSynthesizer()
    /// Speech is rendered to buffers and played through the app's own engine:
    /// iOS only treats an app as "now playing" (lock screen, CarPlay) when its
    /// audio session is producing sound, which AVSpeechSynthesizer.speak() doesn't do.
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var playerFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var segments: [SpeechSegment] = []
    private var timeline = SpeechTimeline(segments: [], rate: 1)
    private(set) var index = 0
    private(set) var state: State = .idle
    private var rate = 1.0
    private var voiceId: String?
    private var bookTitle = ""
    private var bookId: String?
    /// Bumped whenever playback jumps, so buffers and callbacks from an older segment are dropped.
    private var generation = 0
    private var endScheduled = false
    /// Buffers scheduled for the current paragraph that haven't finished playing.
    private var pendingBuffers = 0
    /// The synthesizer has delivered all of the current paragraph's audio.
    private var renderingDone = false
    /// The paragraph finished while paused; resume moves on to the next one.
    private var advancePending = false
    /// The utterance being rendered, to match the synthesizer's didFinish callback.
    private var currentUtterance: ObjectIdentifier?
    /// The position changed (or the engine reset) while paused: resume re-renders from `index`,
    /// skipping `resumeFrames` of it.
    private var needsRestart = false
    /// Audio of the current paragraph already heard, in frames. Counted per
    /// buffer as it finishes playing, so a restart lands at most one short
    /// buffer early rather than at the top of the paragraph.
    private var playedFrames: AVAudioFramePosition = 0
    /// Where in `index` a restart picks up (0 after a seek).
    private var resumeFrames: AVAudioFramePosition = 0
    /// Leading audio of the paragraph still to drop while re-rendering it.
    private var skip = FrameSkip(frames: 0)
    /// Playback was going when another app (Siri, a call) interrupted it.
    private var resumeAfterInterruption = false
    private var interruptedAt: Date?
    /// Interruptions shorter than this resume on their own even when iOS
    /// doesn't say to, which is how Siri finishes.
    private static let briefInterruption: TimeInterval = 120
    private var segmentStartedAt = Date()
    private var commandsRegistered = false
    private static let skipSeconds = 15.0

    override init() {
        super.init()
        synth.delegate = self
        engine.attach(player)
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(audioInterrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        center.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
        // The engine stops itself when the output changes (e.g. connecting to CarPlay).
        center.addObserver(self, selector: #selector(engineConfigurationChanged(_:)), name: .AVAudioEngineConfigurationChange, object: engine)
    }

    // MARK: Voices

    static func voices() -> [[String: Any]] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { !$0.voiceTraits.contains(.isNoveltyVoice) }
            .map { voice in
                let quality: String
                switch voice.quality {
                case .premium: quality = "premium"
                case .enhanced: quality = "enhanced"
                default: quality = "default"
                }
                let name = voice.voiceTraits.contains(.isPersonalVoice) ? "\(voice.name) (Personal Voice)" : voice.name
                return ["id": voice.identifier, "name": name, "lang": voice.language, "quality": quality]
            }
    }

    var status: [String: Any] {
        var status: [String: Any] = ["index": index, "state": state.rawValue, "count": segments.count]
        if let bookId { status["bookId"] = bookId }
        return status
    }

    /// Where a book is being read (playing, or paused while Siri listens), in the
    /// shape the server's `playhead` takes; nil when no whole book is loaded.
    var playhead: [String: Any]? {
        guard state != .idle, let bookId, segments.indices.contains(index),
              let chapterId = segments[index].chapterId, let blockIndex = segments[index].blockIndex else { return nil }
        let segment = segments[index]
        return [
            "bookId": bookId,
            "bookTitle": bookTitle,
            "chapterId": chapterId,
            "chapterTitle": segment.chapterTitle,
            "blockIndex": blockIndex,
            "text": blockIndex >= 0 ? String(segment.text.prefix(300)) : "",
        ]
    }

    // MARK: Controls

    func play(_ request: SpeechPlayRequest) {
        guard !request.segments.isEmpty else { stop(); return }
        segments = request.segments
        rate = request.rate
        voiceId = request.voiceId
        bookTitle = request.bookTitle
        bookId = request.bookId
        timeline = SpeechTimeline(segments: segments, rate: rate)
        registerRemoteCommands()
        speak(at: min(max(request.startIndex, 0), segments.count - 1))
    }

    func pause() {
        guard state == .playing else { return }
        player.pause()
        engine.pause()
        setState(.paused)
    }

    func resume() {
        guard state == .paused, !segments.isEmpty else { return }
        resumeAfterInterruption = false
        if needsRestart { speak(at: index, from: resumeFrames); return }
        if advancePending { speak(at: index + 1); return }
        activateSession()
        do {
            try engine.start()
            player.play()
            setState(.playing)
        } catch {
            speak(at: index, from: playedFrames)
        }
    }

    /// Stops sound for another app (Siri, a call) and remembers exactly where
    /// it was. The engine and synthesizer may be reset meanwhile, so resuming
    /// re-renders the paragraph and skips what was already heard.
    private func suspend() {
        guard state == .playing || state == .paused else { return }
        let wasPlaying = state == .playing
        // Already set to restart (after a seek) or to move on (paragraph done): keep that.
        if !needsRestart && !advancePending {
            needsRestart = true
            resumeFrames = playedFrames
        }
        halt()
        engine.pause()
        if wasPlaying { setState(.paused) }
    }

    func stop() {
        halt()
        engine.stop()
        segments = []
        index = 0
        setState(.idle)
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Jumps to a segment, keeping the paused/playing state.
    private func seek(to target: Int) {
        guard !segments.isEmpty else { return }
        let clamped = min(max(target, 0), segments.count - 1)
        if state == .playing {
            speak(at: clamped)
        } else {
            halt()
            needsRestart = true
            resumeFrames = 0
            advancePending = false
            index = clamped
            segmentStartedAt = Date()
            onEvent?(["type": "progress", "index": index])
            if state == .idle { setState(.paused) } else { updateNowPlaying() }
        }
    }

    // MARK: Speaking

    /// Cancels rendering and drops scheduled audio.
    private func halt() {
        generation += 1
        synth.stopSpeaking(at: .immediate)
        player.stop()
    }

    /// Starts reading segment `i`, skipping its first `frames` of audio.
    private func speak(at i: Int, from frames: AVAudioFramePosition = 0) {
        halt()
        guard segments.indices.contains(i) else { finish(); return }
        index = i
        needsRestart = false
        resumeAfterInterruption = false
        playedFrames = max(0, frames)
        resumeFrames = 0
        skip = FrameSkip(frames: playedFrames)
        endScheduled = false
        pendingBuffers = 0
        renderingDone = false
        advancePending = false
        activateSession()
        let utterance = AVSpeechUtterance(string: segments[i].text)
        if let voiceId, let voice = AVSpeechSynthesisVoice(identifier: voiceId) { utterance.voice = voice }
        utterance.rate = SpeechTimeline.utteranceRate(
            for: rate, defaultRate: AVSpeechUtteranceDefaultSpeechRate,
            min: AVSpeechUtteranceMinimumSpeechRate, max: AVSpeechUtteranceMaximumSpeechRate)
        let gen = generation
        currentUtterance = ObjectIdentifier(utterance)
        segmentStartedAt = Date()
        synth.write(utterance) { [weak self] buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            // Main queue is FIFO, so buffers are scheduled in order.
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.receive(pcm, generation: gen) } }
        }
        log.info("Speaking segment \(i, privacy: .public) (\(self.segments[i].text.count, privacy: .public) chars) from frame \(frames, privacy: .public)")
        onEvent?(["type": "progress", "index": i])
        setState(.playing)
    }

    private func receive(_ pcm: AVAudioPCMBuffer, generation gen: Int) {
        guard gen == generation else { return }
        // iOS also sends empty buffers partway through an utterance, so they
        // can't mark its end; only didFinish (renderingFinished) does.
        guard pcm.frameLength > 0 else { return }
        // Resuming partway: drop the audio that was already heard.
        let drop = skip.take(AVAudioFramePosition(pcm.frameLength))
        guard drop < AVAudioFramePosition(pcm.frameLength) else { return }
        guard let converted = floatBuffer(pcm), let buffer = Self.trimmed(converted, dropping: drop),
              prepareEngine(for: buffer.format) else { return }
        pendingBuffers += 1
        let frames = AVAudioFramePosition(buffer.frameLength)
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, gen == self.generation else { return }
                    self.pendingBuffers -= 1
                    self.playedFrames += frames
                    self.advanceIfDone()
                }
            }
        }
        if state == .playing && !player.isPlaying { player.play() }
    }

    /// The synthesizer delivered the paragraph's last buffer.
    fileprivate func renderingFinished(generation gen: Int) {
        guard gen == generation else { return }
        renderingDone = true
        advanceIfDone()
    }

    /// Once the whole paragraph has been rendered and played, pauses briefly
    /// (longer after chapter titles) and moves on to the next segment.
    private func advanceIfDone() {
        guard renderingDone, pendingBuffers <= 0, !endScheduled else { return }
        endScheduled = true
        let gen = generation
        let isTitle = segments.indices.contains(index) && segments[index].text == segments[index].chapterTitle
        DispatchQueue.main.asyncAfter(deadline: .now() + (isTitle ? 0.6 : 0.25)) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, gen == self.generation else { return }
                if self.state == .playing { self.speak(at: self.index + 1) } else { self.advancePending = true }
            }
        }
    }

    /// The buffer without its first `drop` frames (itself when there's nothing to drop).
    static func trimmed(_ buffer: AVAudioPCMBuffer, dropping drop: AVAudioFramePosition) -> AVAudioPCMBuffer? {
        guard drop > 0 else { return buffer }
        let length = AVAudioFramePosition(buffer.frameLength)
        guard drop < length, let source = buffer.floatChannelData,
              let out = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: AVAudioFrameCount(length - drop)),
              let target = out.floatChannelData else { return nil }
        let count = Int(length - drop)
        for channel in 0..<Int(buffer.format.channelCount) {
            target[channel].update(from: source[channel].advanced(by: Int(drop)), count: count)
        }
        out.frameLength = AVAudioFrameCount(count)
        return out
    }

    /// The player node needs float samples; some voices render 16-bit integers.
    private func floatBuffer(_ pcm: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if pcm.format.commonFormat == .pcmFormatFloat32 { return pcm }
        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: pcm.format.sampleRate,
                                         channels: pcm.format.channelCount, interleaved: false) else { return nil }
        if converter?.inputFormat != pcm.format || converter?.outputFormat != target {
            converter = AVAudioConverter(from: pcm.format, to: target)
        }
        guard let converter, let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: pcm.frameLength) else { return nil }
        do { try converter.convert(to: out, from: pcm) } catch { return nil }
        return out
    }

    private func prepareEngine(for format: AVAudioFormat) -> Bool {
        if playerFormat != format {
            engine.disconnectNodeOutput(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            playerFormat = format
        }
        guard !engine.isRunning else { return true }
        do {
            try engine.start()
            return true
        } catch {
            onEvent?(["type": "error", "message": "Couldn't start audio: \(error.localizedDescription)"])
            return false
        }
    }

    private func finish() {
        halt()
        engine.stop()
        index = max(0, segments.count - 1)
        setState(.idle)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func setState(_ new: State) {
        state = new
        onEvent?(["type": "state", "state": new.rawValue])
        updateNowPlaying()
    }

    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
        } catch {
            onEvent?(["type": "error", "message": "Couldn't start audio: \(error.localizedDescription)"])
        }
    }

    // MARK: Now Playing (lock screen, Control Center, CarPlay)

    private func updateNowPlaying() {
        guard segments.indices.contains(index) else { return }
        let seg = segments[index]
        let elapsed = timeline.startTime(of: index) + (state == .playing ? Date().timeIntervalSince(segmentStartedAt) : 0)
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: seg.chapterTitle,
            MPMediaItemPropertyAlbumTitle: bookTitle.isEmpty ? "Quill AI" : bookTitle,
            MPMediaItemPropertyArtist: "Quill AI",
            MPMediaItemPropertyPlaybackDuration: timeline.duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: min(elapsed, timeline.duration),
            MPNowPlayingInfoPropertyPlaybackRate: state == .playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPNowPlayingInfoPropertyChapterNumber: seg.chapterIndex,
            MPNowPlayingInfoPropertyChapterCount: timeline.chapterCount,
        ]
        if let image = Self.artwork {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        let center = MPRemoteCommandCenter.shared()
        center.nextTrackCommand.isEnabled = timeline.nextChapterStart(from: index) != nil || index < segments.count - 1
        center.previousTrackCommand.isEnabled = true
    }

    private static let artwork: UIImage? = UIImage(named: "NowPlayingArtwork")

    private func registerRemoteCommands() {
        guard !commandsRegistered else { return }
        commandsRegistered = true
        let center = MPRemoteCommandCenter.shared()
        on(center.playCommand) { me, _ in me.resumeOrRestart() }
        on(center.pauseCommand) { me, _ in me.pause() }
        on(center.togglePlayPauseCommand) { me, _ in me.state == .playing ? me.pause() : me.resumeOrRestart() }
        // Steering-wheel buttons, AirPods double/triple press and CarPlay's track buttons.
        on(center.nextTrackCommand) { me, _ in
            if me.timeline.chapterCount > 1, let next = me.timeline.nextChapterStart(from: me.index) { me.seek(to: next) }
            else { me.seek(to: me.index + 1) }
        }
        on(center.previousTrackCommand) { me, _ in
            me.seek(to: me.timeline.chapterCount > 1 ? me.timeline.previousChapterStart(from: me.index) : me.index - 1)
        }
        center.skipForwardCommand.preferredIntervals = [NSNumber(value: Self.skipSeconds)]
        center.skipBackwardCommand.preferredIntervals = [NSNumber(value: Self.skipSeconds)]
        on(center.skipForwardCommand) { me, _ in me.skip(by: Self.skipSeconds) }
        on(center.skipBackwardCommand) { me, _ in me.skip(by: -Self.skipSeconds) }
        // Dragging the scrubber on the lock screen or in CarPlay.
        on(center.changePlaybackPositionCommand) { me, event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return }
            me.seek(to: me.timeline.index(at: event.positionTime))
        }
    }

    /// Remote commands arrive on the main thread.
    private func on(_ command: MPRemoteCommand, _ action: @escaping @MainActor (SpeechController, MPRemoteCommandEvent) -> Void) {
        command.addTarget { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, !self.segments.isEmpty else { return .noActionableNowPlayingItem }
                action(self, event)
                return .success
            }
        }
    }

    private func resumeOrRestart() {
        if state == .idle { speak(at: index >= segments.count - 1 ? 0 : index) } else { resume() }
    }

    private func skip(by seconds: Double) {
        let elapsed = state == .playing ? Date().timeIntervalSince(segmentStartedAt) : 0
        seek(to: timeline.skip(from: index, elapsedInSegment: elapsed, by: seconds))
    }

    // MARK: Audio session events

    @objc private func audioInterrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            if state == .playing {
                resumeAfterInterruption = true
                interruptedAt = Date()
            }
            suspend()
            log.info("Interrupted at segment \(self.index, privacy: .public), frame \(self.resumeFrames, privacy: .public)")
        } else {
            let opts = AVAudioSession.InterruptionOptions(
                rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            let brief = interruptedAt.map { Date().timeIntervalSince($0) < Self.briefInterruption } ?? false
            log.info("Interruption ended (shouldResume: \(opts.contains(.shouldResume), privacy: .public), brief: \(brief, privacy: .public))")
            if resumeAfterInterruption, opts.contains(.shouldResume) || brief { resume() }
        }
    }

    /// Siri doesn't always end its interruption with a notification, so after a
    /// Siri command finishes, keep trying to pick up where reading left off
    /// until Siri lets go of the audio (or the reader resumes or moves on).
    func resumeAfterSiri() {
        guard resumeAfterInterruption else { return }
        let started = Date()
        func attempt(after delay: TimeInterval) {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.resumeAfterInterruption, self.state == .paused else { return }
                    guard Date().timeIntervalSince(started) < 30 else { self.resumeAfterInterruption = false; return }
                    // Fails while Siri still holds the audio; try again shortly.
                    let session = AVAudioSession.sharedInstance()
                    if !session.secondaryAudioShouldBeSilencedHint, (try? session.setActive(true)) != nil {
                        log.info("Resuming after Siri")
                        self.resume()
                    } else {
                        attempt(after: 1)
                    }
                }
            }
        }
        attempt(after: 2)
    }

    @objc private func engineConfigurationChanged(_ note: Notification) {
        if state == .playing {
            speak(at: index, from: playedFrames)
        } else if state == .paused, !needsRestart, !advancePending {
            // (A finished paragraph needs no replay: resume moves on to the next.)
            needsRestart = true
            resumeFrames = playedFrames
        }
    }

    /// Pause when headphones are unplugged or the car disconnects, like other audio apps.
    @objc private func routeChanged(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
        pause()
    }
}

extension SpeechController: AVSpeechSynthesizerDelegate {
    /// Rendering is done. Hops through the main queue so it lands after the
    /// buffers already queued there.
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                let me = SpeechController.shared
                guard me.currentUtterance == id else { return }
                me.renderingFinished(generation: me.generation)
            }
        }
    }
}
