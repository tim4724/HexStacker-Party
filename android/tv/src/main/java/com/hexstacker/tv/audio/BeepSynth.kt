package com.hexstacker.tv.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import java.util.Collections
import kotlin.math.PI
import kotlin.math.pow
import kotlin.math.sin

/**
 * Synthesized square-wave countdown beeps via [AudioTrack]. Mirrors
 * `DisplayAudio.js playCountdownBeep` and `MusicPlayer.swift.makeBeepBuffer`:
 *
 *  - TICK (`isGo = false`): 440 Hz square, 0.12 s, peak 0.15, linear decay.
 *  - GO   (`isGo = true`) : 600 -> 1200 Hz exponential sweep over the first 0.15 s
 *                           then hold, 0.30 s total, peak 0.18, linear decay.
 *
 * Beeps are independent of the music volume (their own [AudioTrack] at fixed
 * amplitude, USAGE_GAME / CONTENT_TYPE_SONIFICATION), exactly like the web routing
 * beeps to `actx.destination` instead of through the music `masterGain`.
 *
 * The two mono 44.1 kHz / 16-bit PCM buffers are precomputed once in the constructor
 * (~13 k + ~5 k samples, sub-millisecond) and reused. A fresh `MODE_STATIC` track is
 * built per beep and self-releases when its marker is reached; beeps are >= 0.88 s
 * apart (1 s countdown steps) so they never overlap.
 */
class BeepSynth {

    private val tick: ShortArray = render(go = false)
    private val go: ShortArray = render(go = true)

    // Deliver marker callbacks on the main thread so self-release is reliable even if
    // play() is ever invoked from a thread without a prepared Looper.
    private val handler = Handler(Looper.getMainLooper())

    // In-flight tracks. A MODE_STATIC track normally self-releases on its marker, but if
    // the marker never fires (device marker flakiness, audio-focus denial, a non-playing
    // state) the native track would leak for the process lifetime. Retaining a reference
    // lets [release] reclaim any survivors. Synchronized because play() and the marker
    // callback may run on different threads (see [handler]).
    private val inFlight: MutableSet<AudioTrack> = Collections.synchronizedSet(mutableSetOf())

    fun play(isGo: Boolean) {
        val pcm = if (isGo) go else tick
        val track = AudioTrack.Builder()
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
            .setBufferSizeInBytes(pcm.size * BYTES_PER_SAMPLE)
            .build()

        track.write(pcm, 0, pcm.size)
        track.setNotificationMarkerPosition(pcm.size) // frames == samples (mono)
        track.setPlaybackPositionUpdateListener(
            object : AudioTrack.OnPlaybackPositionUpdateListener {
                override fun onMarkerReached(t: AudioTrack) {
                    t.setPlaybackPositionUpdateListener(null)
                    inFlight.remove(t)
                    t.stop()
                    t.release()
                }

                override fun onPeriodicNotification(t: AudioTrack) {}
            },
            handler,
        )
        inFlight.add(track)
        track.play()
    }

    /**
     * Reclaim any tracks whose marker never fired (Activity `onDestroy`). Tracks that
     * self-released on their marker have already removed themselves. Safe to call once.
     */
    fun release() {
        synchronized(inFlight) {
            for (t in inFlight) {
                t.setPlaybackPositionUpdateListener(null)
                t.release()
            }
            inFlight.clear()
        }
    }

    /**
     * Port of `MusicPlayer.swift.makeBeepBuffer` quantized to 16-bit PCM. The waveform
     * and envelope math are byte-identical to the Swift/web; only the final
     * float -> Int16 scaling (`* 32767`) differs (inaudible).
     */
    private fun render(go: Boolean): ShortArray {
        val duration = if (go) 0.30 else 0.12
        val peak = if (go) 0.18 else 0.15
        val frames = (SAMPLE_RATE * duration).toInt()
        val out = ShortArray(frames)
        var phase = 0.0
        for (i in 0 until frames) {
            val t = i.toDouble() / SAMPLE_RATE
            val freq = if (go) {
                val sweep = minOf(t / 0.15, 1.0) // 0..1 over the first 0.15 s
                600.0 * 2.0.pow(sweep) // 600 * 2^sweep -> 600..1200, then hold
            } else {
                440.0
            }
            phase += 2.0 * PI * freq / SAMPLE_RATE
            val square = if (sin(phase) >= 0.0) 1.0 else -1.0
            val envelope = (1.0 - t / duration).coerceAtLeast(0.0) // linear decay to 0
            val sample = square * peak * envelope
            out[i] = (sample * Short.MAX_VALUE)
                .toInt()
                .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
                .toShort()
        }
        return out
    }

    companion object {
        private const val SAMPLE_RATE = 44_100
        private const val BYTES_PER_SAMPLE = 2 // 16-bit mono
    }
}
