package com.hexstacker.tv.render

import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.os.SystemClock
import android.util.AttributeSet
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.annotation.VisibleForTesting
import com.hexstacker.core.model.EngineConstants
import com.hexstacker.core.model.EventType
import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.core.model.PlayerState
import com.hexstacker.core.render.LayoutEngine
import com.hexstacker.core.render.Theme
import com.hexstacker.tv.R
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Per-seat presentation metadata supplied by the coordinator (NOT engine state). */
data class SeatMeta(
    val playerId: Int,
    val name: String,
    val colorSlot: Int,
    val startLevel: Int = 1,
)

/**
 * One animated garbage-meter effect (render-thread-owned). Incoming-attack indicators
 * carry the attacker color; defence cancel-flashes carry white. `rowStart`/`lines` are
 * mutated by the shift/trim bookkeeping (port of DisplayGame.js garbage effect logic).
 */
internal class GarbageFx(
    val startMs: Double,
    val durationMs: Double,
    val maxAlpha: Double,
    val colorInt: Int,
    var lines: Int,
    var rowStart: Int,
)

/**
 * The top-level live board surface: one full-screen [SurfaceView] hosting up to
 * 8 [BoardRenderer]s laid out via `LayoutEngine`, plus a single [BoardAnimations]
 * and the match timer. A near-1:1 port of `public/display/DisplayRender.renderFrame`
 * (clear → per-board shake+draw → animations → timer).
 *
 * Decoupled + stateless w.r.t. networking: the coordinator pushes data in via the
 * ingress methods below (game thread); a dedicated render thread reads the latest
 * and redraws every vsync (animations + pulses are wall-clock driven, so we redraw
 * even when the snapshot is unchanged — same as the web RAF loop). Embed in Compose
 * later via `AndroidView({ BoardSurfaceView(it) })`.
 */
class BoardSurfaceView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : SurfaceView(context, attrs), SurfaceHolder.Callback {

    private val fonts = Fonts(context)
    private val stampCache = HexStampCache()
    private val animations = BoardAnimations().also {
        it.setFonts(fonts)
        // Line-clear popups (i18n double / triple).
        it.setPopupLabels(context.getString(R.string.double_clear), context.getString(R.string.triple_clear))
    }
    private val qrCache = QrCache()

    private val timerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fonts.bold
        textAlign = Paint.Align.CENTER
        color = TvColors.white.argb(Theme.Opacity.label)
        letterSpacing = 0.15f
    }

    // Render-thread-owned (built/read only on the render thread).
    private var renderers: List<BoardRenderer> = emptyList()
    private var seatIndexByPlayerId: Map<Int, Int> = emptyMap()
    // Pre-game/lobby empty PlayerStates, memoized per seat index. The grid + nextPieces are
    // shared constants, so an entry only changes when its seat's id/level changes; caching
    // avoids a fresh allocation per board every frame while no match snapshot is present.
    private var emptySnapshots: Array<PlayerState?> = emptyArray()

    // Timer cache (render thread): the string changes once per second, not per frame.
    private var timerCachedSeconds = -1L
    private var timerCachedStr = ""
    // Glyph-advance scratch: sized for "MM:SS" (5 glyphs) but grown if a match ever runs
    // long enough for minutes to reach 3 digits ("100:00" and beyond, 6+ glyphs).
    private var timerAdvances = FloatArray(5)

    // Garbage-meter effects (render-thread-owned): playerId -> active fx. Mirrors the web
    // garbageIndicatorEffects / garbageDefenceEffects maps (attacker-colored + white flashes).
    private val garbageIndicator = HashMap<Int, MutableList<GarbageFx>>()
    private val garbageDefence = HashMap<Int, MutableList<GarbageFx>>()
    // Last-drawn pendingGarbage per player (pre-event), so a garbage_cancelled can place its
    // flash on the rows that were there before the engine reduced the count this frame.
    private val pendingByPlayer = HashMap<Int, Int>()

    // textHeight override: real Orbitron 'Mg' glyph metrics so multi-board sizing/centering
    // matches the web's ctx.measureText path (LayoutEngine's default is a coarse Swift approx).
    private val measurePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = fonts.bold }
    private val measureRect = Rect()
    private val textHeightOverride: (Double) -> Double = { cs ->
        val nameSize = max(Theme.Font.nameMinPx, cs * Theme.Font.nameScale)
        measurePaint.textSize = nameSize.toFloat()
        measurePaint.getTextBounds("Mg", 0, 2, measureRect)
        measureRect.height().toDouble() + cs * 0.6 // measured glyph box + nameGap (web textHeight)
    }

    // Ingress state (written game/main thread; read render thread).
    @Volatile private var latestSnapshot: GameSnapshot? = null
    @Volatile private var seats: List<SeatMeta> = emptyList()
    @Volatile private var playerCount = 0
    @Volatile private var surfaceW = 0
    @Volatile private var surfaceH = 0
    @Volatile private var layoutDirty = false

    private val eventQueue = ConcurrentLinkedQueue<GameEvent>()
    private val disconnects = ConcurrentHashMap<Int, String>()

    @Volatile private var running = false
    private var renderThread: Thread? = null

    init {
        holder.addCallback(this)
    }

    // ── Ingress (game thread) ─────────────────────────────────────────────────

    /** Set/replace the viewport + seats → rebuild renderers via LayoutEngine. */
    fun setViewport(widthPx: Int, heightPx: Int, playerCount: Int, seats: List<SeatMeta>) {
        this.surfaceW = widthPx
        this.surfaceH = heightPx
        this.playerCount = playerCount
        this.seats = seats
        this.layoutDirty = true
    }

    /** Newest engine snapshot (volatile reference swap; render thread reads latest). */
    fun submitSnapshot(snapshot: GameSnapshot) {
        latestSnapshot = snapshot
    }

    /** One PartyCore.frame() event → drives the animation layer. */
    fun onGameEvent(event: GameEvent) {
        eventQueue.add(event)
    }

    /** Per-board disconnect/rejoin overlay; null clears it. */
    fun setDisconnected(playerId: Int, joinUrl: String?) {
        if (joinUrl == null) disconnects.remove(playerId) else disconnects[playerId] = joinUrl
    }

    /** Clear snapshot/animations/disconnects (game end, return to lobby). */
    fun clear() {
        latestSnapshot = null
        disconnects.clear()
        eventQueue.clear()
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Runtime locale switch. The manifest self-handles `locale` (recreating the
     * Activity would tear down the room), and the framework still dispatches the new
     * Configuration to attached views — so re-resolve the Canvas-layer strings here:
     * the popup labels directly, and the per-renderer HUD labels by marking the
     * layout dirty (rebuildLayout constructs fresh BoardRenderers, whose constructor
     * reads the now-updated resources). Compose chrome updates itself.
     */
    override fun onConfigurationChanged(newConfig: Configuration?) {
        super.onConfigurationChanged(newConfig)
        animations.setPopupLabels(context.getString(R.string.double_clear), context.getString(R.string.triple_clear))
        layoutDirty = true
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        running = true
        renderThread = RenderThread().also { it.start() }
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        surfaceW = width
        surfaceH = height
        layoutDirty = true
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        running = false
        // Join in a loop until the render thread actually stops. A bare join(timeout) can
        // return while the thread is still wedged inside lock/unlockCanvas during a
        // SurfaceFlinger stall, and a still-running thread that then drew onto a recycled
        // bitmap would throw "trying to use a recycled bitmap" (or touch the dead Surface).
        renderThread?.let { t ->
            var joined = false
            while (!joined) {
                try {
                    t.join()
                    joined = true
                } catch (_: InterruptedException) {
                    // Retry the join; never free bitmaps until the thread is confirmed dead.
                }
            }
        }
        renderThread = null
        // Thread is stopped → safe to free bitmaps + clear render-thread state from here.
        for (r in renderers) r.recycle()
        renderers = emptyList()
        stampCache.clear()
        qrCache.clear()
        garbageIndicator.clear()
        garbageDefence.clear()
        pendingByPlayer.clear()
    }

    // ── Render thread ─────────────────────────────────────────────────────────

    private inner class RenderThread : Thread("hex-render") {
        override fun run() {
            val h = holder
            while (running) {
                var canvas: Canvas? = null
                try {
                    canvas = h.lockHardwareCanvas()
                    if (canvas == null) {
                        sleep(8)
                        continue
                    }
                    drawFrame(canvas)
                } catch (t: Throwable) {
                    // Surface-teardown races land here benignly (running flips false first);
                    // anything else would silently blank the board forever, so leave a trace.
                    if (running) Log.w(TAG, "drawFrame failed", t)
                } finally {
                    if (canvas != null) runCatching { h.unlockCanvasAndPost(canvas) }
                }
            }
        }
    }

    /**
     * Test-only: render one full multi-board frame straight onto [canvas], bypassing
     * the SurfaceView render thread (which needs a real Surface + hardware canvas that
     * a headless JVM/Robolectric run has no way to provide). This is the exact path the
     * render thread runs every vsync, so a screenshot captured through it is a genuine
     * in-game frame. Call after [setViewport] + [submitSnapshot].
     */
    @VisibleForTesting
    internal fun renderFrameForTest(canvas: Canvas) = drawFrame(canvas)

    private fun drawFrame(canvas: Canvas) {
        val nowMs = SystemClock.uptimeMillis().toDouble()

        if (layoutDirty) rebuildLayout()

        canvas.drawColor(Theme.bgPrimary.toArgb()) // full clear (#1E1A2B)

        animations.beginFrame(nowMs)
        drainEvents(nowMs)
        pruneGarbageFx(nowMs)

        val snap = latestSnapshot
        if (snap == null) {
            // Pre-game static boards.
            for (i in renderers.indices) {
                val seat = seats.getOrNull(i) ?: continue
                renderers[i].render(canvas, emptySnapshotFor(i, seat), nowMs)
            }
        } else {
            val players = snap.players
            for (j in players.indices) {
                val r = renderers.getOrNull(j) ?: continue
                val player = players[j]
                val shake = animations.shakeOffsetFor(r.boardX, r.boardY)
                val shaking = shake.x != 0f || shake.y != 0f
                if (shaking) {
                    canvas.save()
                    canvas.translate(shake.x, shake.y)
                }
                r.render(canvas, player, nowMs)
                r.drawGarbageEffects(canvas, garbageIndicator[player.id], nowMs, 0.2) // incoming attack
                r.drawGarbageEffects(canvas, garbageDefence[player.id], nowMs, 0.3)   // defence flash
                disconnects[player.id]?.let { url ->
                    r.drawDisconnectedOverlay(canvas, qrCache.get(url))
                }
                if (shaking) canvas.restore()
            }
            // Remember this frame's pending as the "old" value for next frame's cancel rowStart.
            for (p in players) pendingByPlayer[p.id] = p.pendingGarbage
        }

        animations.update(nowMs)
        animations.render(canvas)

        snap?.elapsed?.let { drawTimer(canvas, it) }
    }

    private fun drainEvents(nowMs: Double) {
        while (true) {
            val e = eventQueue.poll() ?: break
            dispatch(e, nowMs)
        }
    }

    private fun dispatch(e: GameEvent, nowMs: Double) {
        when (e.type) {
            EventType.PIECE_LOCK -> {
                val r = rendererFor(e.playerId) ?: return
                val blocks = e.blocks ?: return
                val tid = e.typeId ?: return
                animations.addHexLockFlash(r, blocks, colorInt(Theme.pieceColors[tid] ?: TvColors.white))
            }
            EventType.LINE_CLEAR -> {
                val r = rendererFor(e.playerId) ?: return
                val cells = e.clearCells ?: return
                val lines = e.lines ?: return
                animations.addHexCellClear(r, cells, lines)
            }
            EventType.GARBAGE_SENT -> {
                val toId = e.toId ?: return
                val lines = e.lines ?: return
                rendererFor(toId)?.let { animations.addGarbageShake(it.boardX, it.boardY) } // shake the RECEIVER
                val attacker = e.senderId?.let { seatColorInt(it) } ?: TvColors.white.toArgb()
                // Shift existing indicators up by `lines`, drop scrolled-off, push the new one
                // over the top rows of the (grown) meter. Port of onGarbageSent (DisplayGame.js).
                val list = garbageIndicator.getOrPut(toId) { mutableListOf() }
                for (fx in list) fx.rowStart -= lines
                list.removeAll { it.rowStart + it.lines <= 0 }
                list.add(GarbageFx(nowMs, 1000.0, 0.94, attacker, lines, maxOf(0, VIS_ROWS - lines)))
            }
            EventType.GARBAGE_CANCELLED -> {
                val pid = e.playerId ?: return
                val lines = e.lines ?: return
                val oldPending = pendingByPlayer[pid] ?: 0
                val cancelled = minOf(lines, oldPending)
                if (cancelled > 0) {
                    // Flash the rows that vanish from the TOP of the old meter (white defence).
                    garbageDefence.getOrPut(pid) { mutableListOf() }
                        .add(GarbageFx(nowMs, 400.0, 0.9, TvColors.white.toArgb(), cancelled, VIS_ROWS - oldPending))
                }
                // Front-trim indicator effects by the cancelled amount (defended garbage).
                garbageIndicator[pid]?.let { list ->
                    var remaining = lines
                    while (remaining > 0 && list.isNotEmpty()) {
                        val front = list[0]
                        if (front.lines <= remaining) { remaining -= front.lines; list.removeAt(0) }
                        else { front.lines -= remaining; front.rowStart += remaining; remaining = 0 }
                    }
                }
            }
            EventType.PLAYER_KO -> {
                val r = rendererFor(e.playerId) ?: return
                animations.addKO(r.boardX, r.boardY, r.boardWidth, r.boardHeight, r.cellSize.toDouble(), r.outlineAbsPath(0.0))
            }
        }
    }

    /** Attacker's identity color as ARGB, resolved from the seat roster (null if unknown). */
    private fun seatColorInt(playerId: Int): Int? {
        val idx = seatIndexByPlayerId[playerId] ?: return null
        val slot = seats.getOrNull(idx)?.colorSlot ?: return null
        return Theme.playerColor(slot).toArgb()
    }

    /** Drop expired garbage effects (age >= duration); empty player lists are removed. */
    private fun pruneGarbageFx(nowMs: Double) {
        pruneFxMap(garbageIndicator, nowMs)
        pruneFxMap(garbageDefence, nowMs)
    }

    private fun pruneFxMap(map: HashMap<Int, MutableList<GarbageFx>>, nowMs: Double) {
        val it = map.values.iterator()
        while (it.hasNext()) {
            val list = it.next()
            list.removeAll { fx -> nowMs - fx.startMs >= fx.durationMs }
            if (list.isEmpty()) it.remove()
        }
    }

    private fun rendererFor(playerId: Int?): BoardRenderer? {
        val pid = playerId ?: return null
        val seat = seatIndexByPlayerId[pid] ?: return null
        return renderers.getOrNull(seat)
    }

    private fun rebuildLayout() {
        // Clear the flag BEFORE snapshotting the inputs: a setViewport()/surfaceChanged()
        // landing mid-rebuild re-marks it and the next frame rebuilds with the fresh
        // values. Clearing at the end would swallow that concurrent update.
        layoutDirty = false
        val w = surfaceW
        val h = surfaceH
        val s = seats
        if (w <= 0 || h <= 0 || s.isEmpty()) { layoutDirty = true; return } // not ready; retry next frame

        for (r in renderers) r.recycle()

        val n = if (playerCount > 0) playerCount else s.size
        // Keep boards inside the TV title-safe area: lay out within a 5%-inset
        // rectangle and shift each origin by the margin (surface stays full-bleed).
        val marginX = w * Theme.Size.tvOverscan
        val marginY = h * Theme.Size.tvOverscan
        val layout = LayoutEngine.layout(n, w - 2 * marginX, h - 2 * marginY, textHeightOverride)

        val newRenderers = ArrayList<BoardRenderer>(layout.placements.size)
        val idx = HashMap<Int, Int>()
        for ((i, pl) in layout.placements.withIndex()) {
            val seat = s.getOrNull(i) ?: continue
            newRenderers.add(
                BoardRenderer(
                    context = context,
                    geometry = layout.geometry,
                    boardX = (pl.originX + marginX).toFloat(),
                    boardY = (pl.originY + marginY).toFloat(),
                    colorSlot = seat.colorSlot,
                    name = seat.name,
                    stampCache = stampCache,
                    fonts = fonts,
                ),
            )
            idx[seat.playerId] = i
        }
        renderers = newRenderers
        seatIndexByPlayerId = idx
        animations.clear()
        // Fresh match layout: drop any garbage effects / stale pending / timer string
        // (render-thread state, safe to clear here).
        garbageIndicator.clear()
        garbageDefence.clear()
        pendingByPlayer.clear()
        emptySnapshots = arrayOfNulls(newRenderers.size)
        timerCachedSeconds = -1L
    }

    // ── Timer (port of DisplayUI.drawTimer) ──────────────────────────────────
    private fun drawTimer(canvas: Canvas, elapsedMs: Double) {
        val totalSeconds = floor(elapsedMs / 1000.0).toLong()
        // The string only changes once per second; reuse it (and the advances array) otherwise.
        if (totalSeconds != timerCachedSeconds) {
            timerCachedSeconds = totalSeconds
            timerCachedStr = String.format(Locale.US, "%02d:%02d", totalSeconds / 60, totalSeconds % 60)
        }
        val timeStr = timerCachedStr

        // Fixed size relative to view height, not cell size, so the clock reads the
        // same regardless of board count and matches the web/tvOS renderers (all
        // three size off full screen height; only the position is title-safe inset).
        val timerSize = max(24f, min(surfaceH * 0.04f, 60f))
        // Nudge the clock into the same TV title-safe margin as the boards, matching
        // tvOS (which positions the timer inside playRect). Web has no inset (margin 0).
        val marginX = surfaceW * Theme.Size.tvOverscan.toFloat()
        val marginY = surfaceH * Theme.Size.tvOverscan.toFloat()
        val labelSize = timerSize.roundToInt().toFloat()
        val digitAdvance = labelSize * 0.92f
        val colonAdvance = labelSize * 0.52f

        if (timerAdvances.size < timeStr.length) timerAdvances = FloatArray(timeStr.length)
        val advances = timerAdvances // reused across frames; grown above for long matches
        var timerWidth = 0f
        for (i in timeStr.indices) {
            val a = if (timeStr[i] == ':') colonAdvance else digitAdvance
            advances[i] = a
            timerWidth += a
        }

        val n = renderers.size
        // Odd board counts: left-anchor (a centered clock overlaps the middle board).
        // Centering is unchanged by the inset (symmetric margins keep it at surfaceW/2).
        val startX = if (n > 0 && n % 2 == 1) {
            marginX + timerSize * 0.3f
        } else {
            surfaceW / 2f - timerWidth / 2f
        }
        val y = marginY + timerSize * 0.6f

        timerPaint.textSize = labelSize
        var cursorX = startX
        for (k in timeStr.indices) {
            val charX = cursorX + advances[k] / 2f
            canvas.drawTextB(timeStr[k].toString(), charX, y, timerPaint, TextBaseline.TOP)
            cursorX += advances[k]
        }
    }

    /** Cached empty PlayerState for seat [index], rebuilt only if its id/level changed. */
    private fun emptySnapshotFor(index: Int, seat: SeatMeta): PlayerState {
        if (emptySnapshots.size <= index) emptySnapshots = emptySnapshots.copyOf(index + 1)
        val cached = emptySnapshots[index]
        if (cached != null && cached.id == seat.playerId && cached.level == seat.startLevel) {
            return cached
        }
        return emptySnapshot(seat).also { emptySnapshots[index] = it }
    }

    private fun emptySnapshot(seat: SeatMeta): PlayerState = PlayerState(
        id = seat.playerId,
        grid = EMPTY_GRID,
        currentPiece = null,
        ghost = null,
        holdPiece = null,
        nextPieces = emptyList(),
        level = seat.startLevel,
        lines = 0,
        alive = true,
        pendingGarbage = 0,
        clearingCells = null,
        gridVersion = 0,
    )

    private companion object {
        private const val TAG = "BoardSurfaceView"
        private const val VIS_ROWS = EngineConstants.VISIBLE_ROWS // 15
        private val EMPTY_GRID: List<List<Int>> =
            List(EngineConstants.VISIBLE_ROWS) { List(EngineConstants.COLS) { 0 } }
    }
}
