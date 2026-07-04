package com.hexstacker.tv.audio

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.MainThread
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.hexstacker.tv.R

/**
 * Music + countdown beeps for the Android TV display.
 *
 * Mirrors `public/display/Music.js` + `public/display/DisplayAudio.js` and the proven
 * appletv `MusicPlayer.swift`:
 *  - loops `lunar-joyride.mp3` at [MASTER_VOLUME] (0.50) at a constant rate,
 *  - and synthesized square-wave countdown beeps (see [BeepSynth]) that bypass the
 *    music volume.
 *
 * The music asset is shipped as a raw resource (`res/raw/lunar_joyride.mp3`,
 * referenced via `R.raw.lunar_joyride`). ExoPlayer's default data source resolves the
 * `android.resource://` scheme out of the box.
 *
 * Threading: ExoPlayer is single-threaded — construct this and call every method on
 * the main (UI) thread. The display coordinator is driven from the frame loop on the
 * main thread, so this is naturally satisfied. [BeepSynth] precomputes its PCM once in
 * the constructor; playback is cheap and main-safe.
 *
 * Lifecycle: create in `Activity.onCreate` (or a Compose `remember {}` /
 * `DisposableEffect`), and ALWAYS call [release] in `onDestroy` — ExoPlayer holds a
 * codec + audio focus and leaks warn in logcat.
 */
@MainThread
class MusicPlayer(context: Context) {

    private val appContext = context.applicationContext

    // android.resource://<package>/<resId> — handled by ExoPlayer's DefaultDataSource
    // (routes the android.resource scheme to RawResourceDataSource). Keeps the dep
    // surface to media3-exoplayer + media3-common (no explicit media3-datasource ref).
    private val trackUri: Uri = Uri.parse(
        "android.resource://${appContext.packageName}/${R.raw.lunar_joyride}",
    )

    private val player: ExoPlayer = ExoPlayer.Builder(appContext)
        .setHandleAudioBecomingNoisy(false) // TV: no headphone-unplug pause
        .build()
        .apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_GAME)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            repeatMode = Player.REPEAT_MODE_ONE
            volume = MASTER_VOLUME
            setMediaItem(MediaItem.fromUri(trackUri))
            prepare() // decode/buffer ahead; do not play yet
            playWhenReady = false
        }

    private val beeps = BeepSynth() // precomputes TICK + GO PCM buffers once

    private var muted = false

    // Mirrors Music.js `playing`/`_paused`: pause() only takes effect while the loop runs,
    // resume() only reverses a pause() — so a pause/resume during the pre-GO countdown
    // (music starts at GO) can't start playback that start() never began.
    private var playing = false
    private var pausedByOverlay = false

    // Volume-fade plumbing (mirrors Music.js's linearRampToValueAtTime + `generation`
    // guard so overlapping stop/pause/resume calls cancel cleanly). Main-thread only.
    private val fadeHandler = Handler(Looper.getMainLooper())
    private var fadeGen = 0

    /** The volume the player should settle at: master, or 0 while host-muted. */
    private fun targetVolume(): Float = if (muted) 0f else MASTER_VOLUME

    private fun cancelFade() {
        fadeGen++
        fadeHandler.removeCallbacksAndMessages(null) // this handler is used only for fades
    }

    /** Ramp player volume to [target] over [durationMs], then run [onComplete] (once). */
    private fun fadeTo(target: Float, durationMs: Long, onComplete: (() -> Unit)? = null) {
        cancelFade()
        val gen = fadeGen
        val start = player.volume
        if (durationMs <= 0L || start == target) {
            player.volume = target
            onComplete?.invoke()
            return
        }
        val startTime = SystemClock.uptimeMillis()
        fadeHandler.post(object : Runnable {
            override fun run() {
                if (gen != fadeGen) return // superseded by a newer fade / cancel
                val t = ((SystemClock.uptimeMillis() - startTime).toFloat() / durationMs).coerceIn(0f, 1f)
                player.volume = start + (target - start) * t
                if (t < 1f) fadeHandler.postDelayed(this, FADE_STEP_MS) else onComplete?.invoke()
            }
        })
    }

    /**
     * Host "Game Music" toggle. Mirrors `Music.setMuted`: 0 when muted, else master.
     * The level is preserved so unmute restores [MASTER_VOLUME]. Beeps are gated
     * separately on `!muted` (see [playCountdownBeep] / [playGoTone]).
     */
    fun setMuted(value: Boolean) {
        muted = value
        cancelFade()
        player.volume = targetVolume() // instant, like Music.setMuted
    }

    /** Current host mute state (for callers that gate music start on it). */
    val isMuted: Boolean get() = muted

    /**
     * Start (or restart) the loop from the top. Starts even while muted (at
     * volume 0), so the loop is already running and a later unmute is instantly audible —
     * matching the web keeping its audio graph alive when muted. Web `start` sets the gain
     * immediately (no fade-in), so we do too.
     */
    fun start() {
        cancelFade()
        playing = true
        pausedByOverlay = false
        player.volume = targetVolume()
        player.seekTo(0L)
        player.playWhenReady = true
    }

    /** Stop the loop: fade out (0.4s, web) then pause + rewind (match end / return to lobby). */
    fun stop() {
        playing = false
        pausedByOverlay = false
        fadeTo(0f, STOP_FADE_MS) {
            player.playWhenReady = false
            player.seekTo(0L)
        }
    }

    /** Pause during gameplay (overlay): fade out (0.3s, web) then pause, keeping the
     *  position. No-op while the loop isn't running (Music.js `if (!playing) return`). */
    fun pause() {
        if (!playing) return
        playing = false
        pausedByOverlay = true
        fadeTo(0f, PAUSE_FADE_MS) { player.playWhenReady = false }
    }

    /** Resume from [pause]: re-arm playback and fade the volume back in over 0.3s.
     *  No-op unless a [pause] is actually pending (Music.js `if (!_paused) return`). */
    fun resume() {
        if (playing || !pausedByOverlay) return
        playing = true
        pausedByOverlay = false
        cancelFade()
        player.playWhenReady = true
        player.volume = 0f
        fadeTo(targetVolume(), PAUSE_FADE_MS)
    }

    /**
     * Countdown tick for steps 3, 2, 1: a 440 Hz square blip. The web plays the same
     * tick for every step, so the countdown value carries no audio meaning and is not
     * passed. Gated on `!muted` (DisplayAudio.js: `if (muted) return;`).
     */
    fun playCountdownBeep() {
        if (muted) return
        beeps.play(isGo = false)
    }

    /** GO tone — 600->1200 Hz square sweep. Gated on `!muted`. */
    fun playGoTone() {
        if (muted) return
        beeps.play(isGo = true)
    }

    /**
     * App backgrounded (Activity onStop): halt playback IMMEDIATELY (no fade — the main
     * looper stops delivering our fade steps once we're in the background, which would
     * otherwise leave ExoPlayer playing over the launcher). Playback position is kept.
     */
    fun pauseForBackground() {
        cancelFade()
        player.playWhenReady = false
    }

    /** App foregrounded (Activity onStart) while a match is live: restore playback at once. */
    fun resumeFromBackground() {
        cancelFade()
        player.volume = targetVolume()
        player.playWhenReady = true
    }

    /** Free native audio resources (Activity `onDestroy`). Safe to call once. */
    fun release() {
        cancelFade()
        player.release()
        beeps.release()
    }

    companion object {
        /** `Music.js` MASTER_VOLUME. */
        const val MASTER_VOLUME = 0.50f
        private const val FADE_STEP_MS = 16L   // ~1 frame between volume steps
        private const val STOP_FADE_MS = 400L  // Music.stop linearRamp 0.4s
        private const val PAUSE_FADE_MS = 300L // Music.pause / resume linearRamp 0.3s
    }
}
