package com.hexstacker.tv.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack

/**
 * Holds the platform audio output out of standby while the app is foregrounded.
 *
 * AudioFlinger puts an output mixer thread into standby after 3 s without an ACTIVE
 * track, and leaving standby powers the HAL / HDMI path back up. That wake-up audibly
 * mangles the first tens of milliseconds of whatever sound triggered it — on this app
 * always the countdown "3" tick, the first sound of a session (the lobby is silent,
 * and neither ExoPlayer's prepared-but-paused track nor [BeepSynth]'s precomputed PCM
 * keeps the output awake; verified via dumpsys media.audio_flinger). The web and tvOS
 * ports don't hit this because their audio graphs (AudioContext / AVAudioEngine) run
 * continuously.
 *
 * An infinitely looping MODE_STATIC buffer of silence keeps one active track on the
 * mixer at zero steady-state cost: no feeder thread, no callbacks, nothing audible.
 * Same USAGE_GAME / CONTENT_TYPE_SONIFICATION attributes as the beeps, so it holds
 * open exactly the output thread the beeps play on.
 *
 * Main-thread only (like [MusicPlayer]). [start] is idempotent; call [stop] when the
 * app is backgrounded so the device's audio pipeline can actually sleep.
 */
class OutputKeepAlive {

    private var track: AudioTrack? = null

    fun start() {
        if (track != null) return
        val silence = ShortArray(FRAMES) // zeros
        track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_GAME)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(silence.size * BYTES_PER_SAMPLE)
            .build()
            .apply {
                write(silence, 0, silence.size)
                setLoopPoints(0, FRAMES, -1) // loop forever, frames == samples (mono)
                play()
            }
    }

    fun stop() {
        track?.let {
            it.pause()
            it.release()
        }
        track = null
    }

    companion object {
        private const val SAMPLE_RATE = 44_100
        private const val BYTES_PER_SAMPLE = 2 // 16-bit mono
        private const val FRAMES = SAMPLE_RATE / 10 // 100 ms of silence per loop
    }
}
