import AVFoundation

/// Music + countdown beeps via AVAudioEngine. Mirrors public/display/Music.js and
/// DisplayAudio.js: looping track at 0.50 master volume at a constant rate, and
/// square-wave countdown beeps that bypass the music volume.
final class MusicPlayer {

    private let engine = AVAudioEngine()
    private let musicPlayer = AVAudioPlayerNode()
    private let musicMixer = AVAudioMixerNode()   // carries the 0.50 master volume
    private let beepPlayer = AVAudioPlayerNode()

    private var buffer: AVAudioPCMBuffer?
    private var isPlaying = false
    private var isPaused = false
    private var configChangeObserver: NSObjectProtocol?

    private static let masterVolume: Float = 0.50
    // Beeps are mono; the player is connected with this exact format and the
    // mixer up-mixes to the output. Connection format MUST match the scheduled
    // buffer's format, or AVAudioEngine asserts on channel-count mismatch.
    private let beepFormat = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!

    init() {
        engine.attach(musicPlayer)
        engine.attach(musicMixer)
        engine.attach(beepPlayer)

        // Load the track first so the music chain is connected with the buffer's
        // own format (player format must match the scheduled buffer).
        loadTrack()
        let musicFormat = buffer?.format
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
        if let configChangeObserver { NotificationCenter.default.removeObserver(configChangeObserver) }
    }

    private func loadTrack() {
        guard let url = AssetLocator.url(name: "lunar-joyride", ext: "mp3"),
              let file = try? AVAudioFile(forReading: url),
              let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat,
                                         frameCapacity: AVAudioFrameCount(file.length)) else { return }
        try? file.read(into: buf)
        buffer = buf
    }

    func start() {
        guard let buffer else { return }
        startEngineIfNeeded()
        musicMixer.outputVolume = Self.masterVolume
        musicPlayer.stop()
        musicPlayer.scheduleBuffer(buffer, at: nil, options: [.loops])
        musicPlayer.play()
        isPlaying = true
        isPaused = false
    }

    func stop() {
        musicPlayer.stop()
        isPlaying = false
        isPaused = false
    }

    func pause() {
        isPaused = true
        musicPlayer.pause()
    }
    func resume() {
        isPaused = false
        startEngineIfNeeded()
        if isPlaying { musicPlayer.play() }
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
