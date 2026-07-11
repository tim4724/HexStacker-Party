package com.hexstacker.tv.ui

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The web's one shadow token (--shadow-sm: 0 2px 4px rgba(0,0,0,0.32)) as a
 * blurred rounded rect behind the content; bounds are web-px/1.5 in dp.
 * Deliberately NOT Modifier.shadow: elevation shadows are composited by HWUI
 * and don't render under Robolectric, so the gallery columns would silently
 * lose them. Apply BEFORE clip() so the blur isn't cut at the card bounds.
 */
fun Modifier.shadowSm(cornerRadius: Dp): Modifier = drawBehind {
    val r = cornerRadius.toPx()
    val dy = 1.33.dp.toPx() // web offset-y 2px
    val blur = 2.67.dp.toPx() // web blur 4px
    drawIntoCanvas { canvas ->
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            color = 0x52000000 // black at 0.32
            maskFilter = android.graphics.BlurMaskFilter(blur, android.graphics.BlurMaskFilter.Blur.NORMAL)
        }
        canvas.nativeCanvas.drawRoundRect(0f, dy, size.width, size.height + dy, r, r, paint)
    }
}
