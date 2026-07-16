import AVFoundation

/// Music + countdown beeps via AVAudioEngine. Mirrors public/display/Music.js and
/// DisplayAudio.js: looping track at 0.50 master volume at a constant rate, and
/// square-wave countdown beeps that bypass the music volume.
final class MusicPlayer {

    private let engine = AVAudioEngine()
    private let musicPlayer = AVAudioPlayerNode()
    private let musicMixer = AVAudioMixerNode()   // carries the 0.50 master volume
    private let beepPlayer = AVAudioPlayerNode()

    private var trackURL: URL?
    private var trackFormat: AVAudioFormat?
    // Invalidates in-flight loop-pass completions after a stop()/start(): a stale
    // completion from a flushed schedule must not append an extra pass to the
    // fresh queue (the queue would grow by one on every restart).
    private var loopGeneration = 0
    private var isPlaying = false
    private var isPaused = false
    private var configChangeObserver: NSObjectProtocol?

    // Volume-fade timer (mirrors Music.js's linearRampToValueAtTime; invalidation
    // plays the role of its `generation` guard, so overlapping stop/pause/resume
    // calls cancel cleanly). Main-thread only.
    private var fadeTimer: Timer?

    private static let masterVolume: Float = 0.50
    // Beeps are mono; the player is connected with this exact format and the
    // mixer up-mixes to the output. Connection format MUST match the scheduled
    // buffer's format, or AVAudioEngine asserts on channel-count mismatch.
    private let beepFormat = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!

    init() {
        engine.attach(musicPlayer)
        engine.attach(musicMixer)
        engine.attach(beepPlayer)

        // Resolve the track's format first so the music chain is connected with it
        // (player format must match the scheduled file's processing format). Only
        // the file HEADER is read here — passes are decoded incrementally during
        // playback (see schedulePass), not pre-decoded into a ~40 MB PCM buffer.
        loadTrack()
        let musicFormat = trackFormat
            ?? AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 2)!

        // Music chain: player -> musicMixer(0.5) -> main mixer.
        engine.connect(musicPlayer, to: musicMixer, format: musicFormat)
        engine.connect(musicMixer, to: engine.mainMixerNode, format: nil)
        // Beeps go straight to the main mixer (not attenuated by music volume).
        engine.connect(beepPlayer, to: engine.mainMixerNode, format: beepFormat)

        musicMixer.outputVolume = Self.masterVolume

        // An output route/config change (HDMI-CEC handoff, AVR, AirPlay) stops
        // the engine; without this, audio stays dead until the next match's
        // start(). Restart and resume whatever was audible.
        configChangeObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.startEngineIfNeeded()
            if self.isPlaying && !self.isPaused { self.musicPlayer.play() }
        }
    }

    deinit {
        fadeTimer?.invalidate()
        if let configChangeObserver { NotificationCenter.default.removeObserver(configChangeObserver) }
    }

    private func loadTrack() {
        guard let url = AssetLocator.url(name: "lunar-joyride", ext: "mp3"),
              let file = try? AVAudioFile(forReading: url) else { return }
        trackURL = url
        trackFormat = file.processingFormat
    }

    func start() {
        guard trackURL != nil else { return }
        startEngineIfNeeded()
        cancelFade()
        musicMixer.outputVolume = Self.masterVolume
        loopGeneration += 1
        musicPlayer.stop()
        schedulePass(generation: loopGeneration)
        schedulePass(generation: loopGeneration) // one pass buffered ahead = gapless
        musicPlayer.play()
        isPlaying = true
        isPaused = false
    }

    /// Queue one full pass of the track; when it is consumed, queue the next. With
    /// two passes in flight the player never starves (gapless loop) while the file
    /// decodes incrementally. A fresh AVAudioFile per pass keeps each schedule's
    /// read position independent (overlapping schedules of ONE file share its
    /// framePosition and corrupt each other).
    private func schedulePass(generation: Int) {
        guard let url = trackURL, let file = try? AVAudioFile(forReading: url) else { return }
        musicPlayer.scheduleFile(file, at: nil) { [weak self] in
            // Fires on the render thread; player scheduling must hop off it.
            DispatchQueue.main.async {
                guard let self, self.isPlaying, generation == self.loopGeneration else { return }
                self.schedulePass(generation: generation)
            }
        }
    }

    /// Stop the loop: fade out (0.4s, Music.js stop) then halt the player.
    func stop() {
        isPlaying = false
        isPaused = false
        fade(to: 0, duration: 0.4) { [weak self] in self?.musicPlayer.stop() }
    }

    /// Pause (overlay / host mute): fade out (0.3s, Music.js pause) then pause,
    /// keeping the position.
    func pause() {
        isPaused = true
        fade(to: 0, duration: 0.3) { [weak self] in self?.musicPlayer.pause() }
    }

    /// Resume from pause: restart playback silent and fade back in over 0.3s
    /// (Music.js resume).
    func resume() {
        isPaused = false
        startEngineIfNeeded()
        guard isPlaying else { return }
        musicMixer.outputVolume = 0
        musicPlayer.play()
        fade(to: Self.masterVolume, duration: 0.3)
    }

    /// Countdown beep. Tick: 440Hz square 0.12s; Go: 600->1200Hz sweep 0.3s.
    /// Mute is enforced by the caller (DisplayCoordinator gates the beep).
    func playBeep(go: Bool) {
        startEngineIfNeeded()
        guard let buf = makeBeepBuffer(go: go) else { return }
        beepPlayer.scheduleBuffer(buf, at: nil, options: [.interrupts])
        beepPlayer.play()
    }

    // MARK: - Internals

    private func cancelFade() {
        fadeTimer?.invalidate()
        fadeTimer = nil
    }

    /// Ramp `musicMixer.outputVolume` to `target` over `duration`, then run
    /// `completion` (once). A newer fade/cancel supersedes both the ramp and the
    /// pending completion.
    private func fade(to target: Float, duration: TimeInterval, completion: (() -> Void)? = nil) {
        cancelFade()
        let start = musicMixer.outputVolume
        guard duration > 0, start != target else {
            musicMixer.outputVolume = target
            completion?()
            return
        }
        let startTime = Date()
        fadeTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            let t = Float(min(Date().timeIntervalSince(startTime) / duration, 1))
            self.musicMixer.outputVolume = start + (target - start) * t
            if t >= 1 {
                timer.invalidate()
                self.fadeTimer = nil
                completion?()
            }
        }
    }

    private func startEngineIfNeeded() {
        guard !engine.isRunning else { return }
        try? engine.start()
    }

    private func makeBeepBuffer(go: Bool) -> AVAudioPCMBuffer? {
        let format = beepFormat
        let sampleRate = format.sampleRate
        let duration = go ? 0.30 : 0.12
        let peak: Float = go ? 0.18 : 0.15
        let frames = AVAudioFrameCount(sampleRate * duration)
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        buf.frameLength = frames
        guard let ch = buf.floatChannelData?[0] else { return nil }

        var phase = 0.0
        for i in 0..<Int(frames) {
            let t = Double(i) / sampleRate
            let freq: Double
            if go {
                // Exponential sweep 600 -> 1200 over first 0.15s, then hold 1200.
                let sweep = min(t / 0.15, 1.0)
                freq = 600 * pow(2.0, sweep)   // 600 * 2^1 = 1200
            } else {
                freq = 440
            }
            phase += 2 * Double.pi * freq / sampleRate
            let square: Float = sin(phase) >= 0 ? 1 : -1
            let envelope = Float(1.0 - t / duration)   // linear decay to 0
            ch[i] = square * peak * max(0, envelope)
        }
        return buf
    }
}
