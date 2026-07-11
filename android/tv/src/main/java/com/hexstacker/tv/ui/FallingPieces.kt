package com.hexstacker.tv.ui

import kotlin.math.ceil
import kotlin.math.sqrt
import kotlin.random.Random

/** One falling background particle. [x]/[y] are the piece-anchor position. */
class FallingPiece(
    val cells: List<IntArray>, // axial [q, r] offsets of the chosen rotation
    val blockSize: Float, // hex circumradius (12..32 reference px)
    val speed: Float, // reference px/s downward
    val opacity: Float, // 0..1 (already includes per-color boost)
    val colorArgb: Int,
    var x: Float,
    var y: Float,
)

/**
 * Pure (no Android/Compose) port of `WelcomeBackground.js` pool management:
 * grid-seeded particles raining in from above, round-robin recycle, dt-clamped
 * advance. Android `Canvas`/Compose is Y-down like the web, so there is NO sign
 * flip (unlike the SpriteKit tvOS port). Kept framework-free so the math is
 * unit-testable on the JVM.
 *
 * Coordinates are in whatever space [resize] is given: LobbyBackground feeds the
 * 1920-wide reference space and scales to the canvas at draw time, keeping the
 * hardcoded 12..32px sizes resolution-independent (web CSS px / tvOS points).
 */
class FallingPieceField(
    val poolSize: Int = 15, // WelcomeBackground constructor default
    private val random: Random = Random.Default,
) {
    var w: Float = 0f
        private set
    var h: Float = 0f
        private set

    val pool: MutableList<FallingPiece> = ArrayList(poolSize)

    private var nextCol = 0
    private var cols = 1
    private var seeded = false

    /** Set/scale the viewport. Seeds the pool on first non-zero size; thereafter
     *  scales existing particle positions proportionally (web `resize`). */
    fun resize(newW: Float, newH: Float) {
        if (newW <= 0f || newH <= 0f) return
        if (!seeded) {
            w = newW
            h = newH
            initPool()
            seeded = true
            return
        }
        if (newW == w && newH == h) return
        val oldW = w
        val oldH = h
        for (p in pool) {
            p.x = p.x / oldW * newW
            p.y = p.y / oldH * newH
        }
        w = newW
        h = newH
    }

    /** Advance all particles by [dt] seconds; recycle any that fall past the bottom. */
    fun advance(dt: Float) {
        if (!seeded) return
        val maxY = h + 200f // web `maxY = this.h + 200`
        for (i in pool.indices) {
            val p = pool[i]
            p.y += p.speed * dt
            if (p.y > maxY) pool[i] = recycle()
        }
    }

    private fun initPool() {
        pool.clear()
        cols = ceil(sqrt(poolSize * 1.5)).toInt().coerceAtLeast(1)
        val rows = ceil(poolSize.toFloat() / cols).toInt().coerceAtLeast(1)
        val cellW = w / cols
        val cellH = h * 1.5f / rows
        var idx = 0
        var r = 0
        while (r < rows && idx < poolSize) {
            var c = 0
            while (c < cols && idx < poolSize) {
                val s = makeShape()
                s.x = cellW * (c + 0.1f + random.nextFloat() * 0.8f)
                s.y = -(cellH * (r + 0.1f + random.nextFloat() * 0.8f)) // seeded above screen
                pool.add(s)
                idx++
                c++
            }
            r++
        }
        nextCol = 0
    }

    private fun recycle(): FallingPiece {
        val cellW = w / cols
        val col = nextCol
        nextCol = (nextCol + 1) % cols
        val s = makeShape()
        s.x = cellW * (col + 0.1f + random.nextFloat() * 0.8f)
        s.y = -s.blockSize * 4f - random.nextFloat() * 100f
        return s
    }

    private fun makeShape(): FallingPiece {
        val kind = PieceShapes.pieces[random.nextInt(PieceShapes.pieces.size)]
        val cells = kind.rotations[random.nextInt(kind.rotations.size)]
        val blockSize = 12f + random.nextFloat() * 20f // 12..32 px
        val speed = 15f + (32f - blockSize) / 20f * 25f
        val opacity = 0.14f + random.nextFloat() * 0.08f + kind.opacityBoost
        return FallingPiece(cells, blockSize, speed, opacity, kind.colorArgb, 0f, 0f)
    }
}
