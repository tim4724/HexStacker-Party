package com.hexstacker.tv.render

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import com.hexstacker.core.model.Cell
import com.hexstacker.core.model.EngineConstants
import com.hexstacker.core.render.Theme
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.random.Random

/** Active shake translate for one board (screen px); ZERO when not shaking. */
data class ShakeOffset(val x: Float, val y: Float)

/**
 * On-board feedback animations: lock-flash sparkles, line-clear flash + popup +
 * confetti, garbage shake, and the KO red/white flash. Port of
 * `public/display/Animations.js`.
 *
 * A SINGLE instance per surface (confetti/popups cross board boundaries). All
 * state (`active`) is touched only on the render thread: ingress methods are
 * invoked from the surface view's frame-top event drain, then [update] + [render]
 * run after the boards are drawn. Call [beginFrame] first so newly-spawned anims
 * stamp the same monotonic clock the loop uses.
 */
class BoardAnimations {

    private val active = ArrayList<Anim>()
    private var now: Double = 0.0

    // Reused paints/paths (render thread only).
    private val sparklePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val sparklePath = Path()
    private val flashPath = Path()
    private val flashPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val popupPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val koAnimPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }

    private val whiteInt = TvColors.white.toArgb()
    private val redInt = com.hexstacker.core.render.Rgb(255, 0, 0).toArgb()

    /** Set the monotonic clock for this frame BEFORE draining events into ingress. */
    fun beginFrame(nowMs: Double) {
        now = nowMs
    }

    // ── Ingress (render thread) ───────────────────────────────────────────────

    fun addSparkle(
        x: Double,
        y: Double,
        colorInt: Int,
        duration: Double,
        cellSize: Double,
        sizeBase: Double = 0.05,
        sizeRange: Double = 0.07,
    ) {
        val vx = (Random.nextDouble() - 0.5) * 120
        val vy = -Random.nextDouble() * 80 - 20
        val rotStart = Random.nextDouble() * PI * 2
        val rotSpeed = (Random.nextDouble() - 0.5) * 6 // rad/s
        val size = cellSize * (sizeBase + Random.nextDouble() * sizeRange)
        active.add(Sparkle(now, duration, x, y, vx, vy, colorInt, rotStart, rotSpeed, size))
    }

    /** Line-clear: white flash + shrink, DOUBLE/TRIPLE popup, confetti burst. */
    fun addHexCellClear(br: BoardRenderer, cells: List<Cell>, linesCleared: Int) {
        if (cells.isEmpty()) return
        val isTriple = linesCleared == 3
        val bx = br.boardX
        val by = br.boardY
        val hexSize = br.hexSize
        val hexH = br.hexH
        val colW = br.colW

        val positions = ArrayList<FloatArray>(cells.size)
        for (cl in cells) {
            if (cl.row >= 0) {
                positions.add(
                    floatArrayOf(
                        bx + colW * cl.col + hexSize,
                        by + hexH * (cl.row + 0.5f * (cl.col and 1)) + hexH / 2f,
                    ),
                )
            }
        }
        active.add(HexCellClear(now, positions, hexSize))

        val firstCell = cells.firstOrNull { it.row >= 0 }
        if (firstCell != null) {
            val popCol = COLS / 2 // floor(9/2) = 4
            val px = (bx + colW * popCol + hexSize).toDouble()
            val py = (by + hexH * (firstCell.row + 0.5f * (popCol and 1)) + hexH / 2f).toDouble()
            if (isTriple) {
                addTextPopup(px, py, tripleLabel, colorInt(TvColors.triple), true, br.cellSize.toDouble())
            } else if (linesCleared == 2) {
                addTextPopup(px, py, doubleLabel, whiteInt, false, br.cellSize.toDouble())
            }
        }

        for (cl in cells) {
            if (cl.row < 0) continue
            val sx = (bx + colW * cl.col + hexSize).toDouble()
            val sy = (by + hexH * (cl.row + 0.5f * (cl.col and 1)) + hexH / 2f).toDouble()
            val count = if (isTriple) 5 else 2
            for (j in 0 until count) {
                val color = if (isTriple) {
                    colorInt(Theme.pieceColors[CELEBRATION[Random.nextInt(CELEBRATION.size)]] ?: TvColors.white)
                } else {
                    whiteInt
                }
                addSparkle(sx + (Random.nextDouble() - 0.5) * hexSize * 2, sy, color, 200 + Random.nextDouble() * 400, hexSize.toDouble())
            }
        }
    }

    /** Piece-lock: sparkle burst from the bottom-exposed blocks. */
    fun addHexLockFlash(br: BoardRenderer, blocks: List<Cell>, pieceColorInt: Int) {
        if (blocks.isEmpty()) return
        val occupied = HashSet<Int>(blocks.size * 2)
        for (b in blocks) occupied.add(occKey(b.col, b.row))
        for (b in blocks) {
            if (b.row < 0 || b.row >= VIS) continue
            if (occKey(b.col, b.row + 1) in occupied) continue // only bottom-exposed blocks emit
            val cx = br.hexCenterX(b.col, b.row).toDouble()
            val cy = br.hexCenterY(b.col, b.row).toDouble()
            for (j in 0 until 5) {
                addSparkle(
                    cx + (Random.nextDouble() - 0.5) * br.hexW,
                    cy + br.hexSize,
                    pieceColorInt,
                    150 + Random.nextDouble() * 250,
                    br.cellSize.toDouble(),
                    0.08, 0.1,
                )
            }
        }
    }

    fun addGarbageShake(boardX: Float, boardY: Float) {
        active.add(Shake(now, boardX, boardY))
    }

    fun addTextPopup(x: Double, y: Double, text: String, colorInt: Int, hasGlow: Boolean, cellSize: Double) {
        active.add(TextPopup(now, x, y, text, colorInt, hasGlow, cellSize))
    }

    /** KO one-shot: red/white flash clipped to the board outline + 12 edge sparkles. */
    fun addKO(boardX: Float, boardY: Float, boardW: Float, boardH: Float, cellSize: Double, outline: Path) {
        active.add(Ko(now, boardX, boardY, boardW, boardH, outline))
        for (i in 0 until 12) {
            addSparkle(
                boardX + Random.nextDouble() * boardW,
                boardY + Random.nextDouble() * boardH,
                colorInt(TvColors.koText),
                600 + Random.nextDouble() * 400,
                cellSize,
            )
        }
    }

    // ── Tick + draw (render thread) ───────────────────────────────────────────

    fun update(nowMs: Double) {
        var w = 0
        for (i in active.indices) {
            val a = active[i]
            // Prune anims that completed on the previous frame (final frame already drawn).
            if (a.progress >= 1.0) continue
            a.progress = min((nowMs - a.startTimeMs) / a.durationMs, 1.0)
            a.onUpdate(a.progress)
            active[w++] = a
        }
        while (active.size > w) active.removeAt(active.size - 1)
    }

    fun render(canvas: Canvas) {
        for (i in active.indices) active[i].render(canvas, active[i].progress)
    }

    fun shakeOffsetFor(boardX: Float, boardY: Float): ShakeOffset {
        for (i in active.indices) {
            val a = active[i]
            if (a is Shake && a.boardX == boardX && a.boardY == boardY) {
                return ShakeOffset(a.offsetX, a.offsetY)
            }
        }
        return ZERO
    }

    fun clear() {
        active.clear()
    }

    // ── Anim hierarchy ────────────────────────────────────────────────────────

    private abstract class Anim(val startTimeMs: Double, val durationMs: Double) {
        var progress: Double = 0.0
        open fun onUpdate(progress: Double) {}
        abstract fun render(canvas: Canvas, progress: Double)
    }

    private inner class Sparkle(
        start: Double,
        duration: Double,
        val x: Double,
        val y: Double,
        val vx: Double,
        val vy: Double,
        val colorInt: Int,
        val rotStart: Double,
        val rotSpeed: Double,
        val size: Double,
    ) : Anim(start, duration) {
        override fun render(canvas: Canvas, progress: Double) {
            val t = progress * durationMs / 1000.0
            val px = (x + vx * t).toFloat()
            val py = (y + vy * t + 80 * t * t).toFloat() // gravity
            val sz = (size * (1 - progress * 0.5)).toFloat()
            val rot = rotStart + rotSpeed * t
            canvas.save()
            canvas.translate(px, py)
            canvas.rotate(Math.toDegrees(rot).toFloat())
            sparklePaint.color = colorInt
            sparklePaint.alpha = a255(1 - progress)
            sparklePath.rewind()
            sparklePath.addHex(0f, 0f, sz)
            canvas.drawPath(sparklePath, sparklePaint)
            canvas.restore()
        }
    }

    private inner class HexCellClear(
        start: Double,
        val cellPositions: List<FloatArray>,
        val hexSize: Float,
    ) : Anim(start, Theme_timing_lineClear) {
        override fun render(canvas: Canvas, progress: Double) {
            flashPaint.color = whiteInt
            if (progress < 0.25) {
                flashPaint.alpha = a255(0.9 * (1 - (progress / 0.25) * 0.5))
                flashPath.rewind()
                for (cp in cellPositions) flashPath.addHex(cp[0], cp[1], hexSize)
                canvas.drawPath(flashPath, flashPaint)
            } else {
                val fade = 0.5 * (1 - (progress - 0.25) / 0.75)
                if (fade <= 0) return
                flashPaint.alpha = a255(fade)
                val shrink = (hexSize * (1 - (progress - 0.25))).toFloat().coerceAtLeast(0f)
                flashPath.rewind()
                for (cp in cellPositions) flashPath.addHex(cp[0], cp[1], shrink)
                canvas.drawPath(flashPath, flashPaint)
            }
        }
    }

    private inner class TextPopup(
        start: Double,
        val x: Double,
        val y: Double,
        val text: String,
        val colorInt: Int,
        val hasGlow: Boolean,
        val cs: Double,
    ) : Anim(start, Theme_timing_textPopup) {
        private val fontSize = (cs * 0.73).toFloat()
        private val highlightY = (-cs * 0.03).toFloat()
        override fun render(canvas: Canvas, progress: Double) {
            val ease = 1 - (1 - progress).pow(3)
            val alpha = if (progress < 0.8) 1.0 else 1 - (progress - 0.8) / 0.2
            val scale = if (progress < 0.15) 0.5 + (progress / 0.15) * 0.7 else 1.2 - ease * 0.2
            canvas.save()
            canvas.translate(x.toFloat(), (y - ease * cs * 1.7).toFloat())
            canvas.scale(scale.toFloat(), scale.toFloat())
            popupPaint.typeface = fontsBlack
            popupPaint.textSize = fontSize
            popupPaint.textAlign = Paint.Align.CENTER
            popupPaint.color = colorInt
            popupPaint.alpha = a255(alpha)
            canvas.drawTextB(text, 0f, 0f, popupPaint, TextBaseline.MIDDLE)
            if (hasGlow) {
                popupPaint.color = whiteInt
                popupPaint.alpha = a255(0.3 * alpha) // web: white@0.3 under globalAlpha=alpha
                canvas.drawTextB(text, 0f, highlightY, popupPaint, TextBaseline.MIDDLE)
            }
            canvas.restore()
        }
    }

    private class Shake(start: Double, val boardX: Float, val boardY: Float) : Anim(start, Theme_timing_garbageShake) {
        var offsetX = 0f
        var offsetY = 0f
        override fun onUpdate(progress: Double) {
            val intensity = (1 - progress) * 2.4
            val freq = 1 - progress * 0.5
            offsetX = (sin(progress * 18) * intensity * freq).toFloat()
            offsetY = (cos(progress * 20) * intensity * 0.18 * freq).toFloat()
        }
        override fun render(canvas: Canvas, progress: Double) {
            // Applied as a canvas translate around the board draw (see surface view).
        }
    }

    private inner class Ko(
        start: Double,
        val boardX: Float,
        val boardY: Float,
        val boardW: Float,
        val boardH: Float,
        val outline: Path,
    ) : Anim(start, Theme_timing_ko) {
        override fun render(canvas: Canvas, progress: Double) {
            val fill: Int
            val alpha: Double
            when {
                progress < 0.15 -> {
                    fill = whiteInt
                    alpha = (1 - progress / 0.15) * 0.7
                }
                progress < 0.4 -> {
                    fill = redInt
                    alpha = ((0.4 - progress) / 0.25) * 0.4
                }
                else -> return
            }
            canvas.save()
            canvas.clipPath(outline)
            koAnimPaint.color = fill
            koAnimPaint.alpha = a255(alpha)
            canvas.drawRect(boardX, boardY, boardX + boardW, boardY + boardH, koAnimPaint)
            canvas.restore()
        }
    }

    // The popup needs the 900-weight face; resolved lazily so BoardAnimations
    // doesn't have to take Fonts in its constructor (kept dependency-free).
    private var fontsBlack = android.graphics.Typeface.create(android.graphics.Typeface.MONOSPACE, 900, false)

    /** Inject the display Black typeface (call once after constructing). */
    fun setFonts(fonts: Fonts) {
        fontsBlack = fonts.black
    }

    // Line-clear popup labels (i18n double / triple). Defaults mirror the web's
    // English; the surface view injects the device-locale values once after
    // construction via [setPopupLabels].
    private var doubleLabel = "DOUBLE"
    private var tripleLabel = "TRIPLE"

    /** Inject the localized DOUBLE / TRIPLE popup labels (call once after constructing). */
    fun setPopupLabels(doubleText: String, tripleText: String) {
        doubleLabel = doubleText
        tripleLabel = tripleText
    }

    companion object {
        private const val VIS = EngineConstants.VISIBLE_ROWS
        private const val COLS = EngineConstants.COLS

        // THEME.timing (ms).
        private const val Theme_timing_lineClear = 600.0
        private const val Theme_timing_garbageShake = 180.0
        private const val Theme_timing_textPopup = 1200.0
        private const val Theme_timing_ko = 1800.0

        // ANIMATIONS_CELEBRATION_PIECE_IDS — palette hexes for triple confetti.
        private val CELEBRATION = intArrayOf(1, 2, 3, 4, 5, 6)

        private val ZERO = ShakeOffset(0f, 0f)

        /** col,row → collision-free int key (row may be negative in the buffer zone). */
        private fun occKey(col: Int, row: Int): Int = col * 64 + (row + 8)
    }
}
