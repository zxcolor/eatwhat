package com.chishenme.app.feature.detail

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import androidx.core.graphics.createBitmap
import java.io.OutputStream
import kotlin.math.min

internal fun interface RestaurantShareCardPngRenderer {
    fun renderPng(content: RestaurantShareCardContent, output: OutputStream): Boolean
}

/** Renders only the allow-listed [RestaurantShareCardContent]; no remote image is fetched. */
internal class RestaurantShareCardRenderer : RestaurantShareCardPngRenderer {
    override fun renderPng(content: RestaurantShareCardContent, output: OutputStream): Boolean {
        val bitmap = createBitmap(CARD_WIDTH, CARD_HEIGHT, Bitmap.Config.ARGB_8888)
        return try {
            draw(Canvas(bitmap), content)
            bitmap.compress(Bitmap.CompressFormat.PNG, PNG_QUALITY, output)
        } finally {
            bitmap.recycle()
        }
    }

    private fun draw(canvas: Canvas, content: RestaurantShareCardContent) {
        canvas.drawColor(CREAM)

        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        }
        canvas.drawRoundRect(
            RectF(MARGIN, 48f, CARD_WIDTH - MARGIN, 256f),
            44f,
            44f,
            paint.apply { color = ORANGE },
        )
        paint.typeface = Typeface.create("sans-serif", Typeface.BOLD)
        paint.textSize = 58f
        paint.color = Color.WHITE
        canvas.drawText("吃什么", MARGIN + 44f, 138f, paint)
        paint.typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        paint.textSize = 30f
        canvas.drawText("现在这顿，快速决定", MARGIN + 44f, 194f, paint)

        paint.color = WHITE
        canvas.drawRoundRect(
            RectF(MARGIN, 292f, CARD_WIDTH - MARGIN, 920f),
            36f,
            36f,
            paint,
        )

        var y = 364f
        paint.color = ORANGE_DARK
        paint.typeface = Typeface.create("sans-serif", Typeface.BOLD)
        paint.textSize = 30f
        canvas.drawText("这顿就吃它", MARGIN + 42f, y, paint)

        y += 72f
        paint.color = INK
        paint.textSize = 54f
        y = drawWrappedText(
            canvas = canvas,
            text = content.restaurantName,
            x = MARGIN + 42f,
            baselineY = y,
            maxWidth = CARD_WIDTH - (MARGIN + 42f) * 2,
            lineHeight = 68f,
            maxLines = 2,
            paint = paint,
        )

        content.address?.let { address ->
            y += 14f
            paint.typeface = Typeface.create("sans-serif", Typeface.NORMAL)
            paint.textSize = 28f
            paint.color = MUTED
            y = drawWrappedText(
                canvas = canvas,
                text = address,
                x = MARGIN + 42f,
                baselineY = y,
                maxWidth = CARD_WIDTH - (MARGIN + 42f) * 2,
                lineHeight = 38f,
                maxLines = 2,
                paint = paint,
            )
        }

        y += 26f
        drawFactPills(canvas, content.facts, y, paint)
        y += 106f

        paint.typeface = Typeface.create("sans-serif", Typeface.BOLD)
        paint.textSize = 30f
        paint.color = INK
        canvas.drawText("为什么推荐", MARGIN + 42f, y, paint)
        y += 50f
        content.reasons.take(3).forEachIndexed { index, reason ->
            paint.color = ORANGE
            canvas.drawCircle(MARGIN + 54f, y - 9f, 14f, paint)
            paint.color = Color.WHITE
            paint.textSize = 20f
            paint.textAlign = Paint.Align.CENTER
            canvas.drawText((index + 1).toString(), MARGIN + 54f, y - 2f, paint)
            paint.textAlign = Paint.Align.LEFT
            paint.color = INK
            paint.typeface = Typeface.create("sans-serif", Typeface.NORMAL)
            paint.textSize = 28f
            y = drawWrappedText(
                canvas = canvas,
                text = reason,
                x = MARGIN + 88f,
                baselineY = y,
                maxWidth = CARD_WIDTH - MARGIN * 2 - 112f,
                lineHeight = 38f,
                maxLines = 2,
                paint = paint,
            ) + 18f
        }

        val noticeTop = 958f
        paint.color = if (content.dataNotice.startsWith("演示数据")) DEMO_BACKGROUND else SOFT_ORANGE
        canvas.drawRoundRect(
            RectF(MARGIN, noticeTop, CARD_WIDTH - MARGIN, 1124f),
            30f,
            30f,
            paint,
        )
        paint.color = if (content.dataNotice.startsWith("演示数据")) DEMO_INK else ORANGE_DARK
        paint.typeface = Typeface.create("sans-serif", Typeface.BOLD)
        paint.textSize = 28f
        drawWrappedText(
            canvas = canvas,
            text = content.dataNotice,
            x = MARGIN + 34f,
            baselineY = noticeTop + 53f,
            maxWidth = CARD_WIDTH - (MARGIN + 34f) * 2,
            lineHeight = 38f,
            maxLines = 2,
            paint = paint,
        )

        var footerY = 1178f
        paint.typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        paint.textSize = 25f
        paint.color = MUTED
        footerY = drawWrappedText(
            canvas = canvas,
            text = content.sourceAttribution,
            x = MARGIN,
            baselineY = footerY,
            maxWidth = CARD_WIDTH - MARGIN * 2,
            lineHeight = 34f,
            maxLines = 2,
            paint = paint,
        )
        content.aiNotice?.let { notice ->
            footerY += 12f
            paint.color = ORANGE_DARK
            paint.typeface = Typeface.create("sans-serif", Typeface.BOLD)
            footerY = drawWrappedText(
                canvas = canvas,
                text = notice,
                x = MARGIN,
                baselineY = footerY,
                maxWidth = CARD_WIDTH - MARGIN * 2,
                lineHeight = 34f,
                maxLines = 2,
                paint = paint,
            )
        }

        paint.color = MUTED
        paint.typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        paint.textSize = 22f
        drawWrappedText(
            canvas = canvas,
            text = content.safetyNotice,
            x = MARGIN,
            baselineY = min(footerY + 38f, 1364f),
            maxWidth = CARD_WIDTH - MARGIN * 2,
            lineHeight = 30f,
            maxLines = 2,
            paint = paint,
        )
    }

    private fun drawFactPills(canvas: Canvas, facts: List<String>, y: Float, paint: Paint) {
        val gap = 16f
        val availableWidth = CARD_WIDTH - MARGIN * 2
        val width = (availableWidth - gap * 2) / 3
        facts.take(3).forEachIndexed { index, fact ->
            val left = MARGIN + index * (width + gap)
            paint.color = SOFT_ORANGE
            canvas.drawRoundRect(RectF(left, y, left + width, y + 72f), 26f, 26f, paint)
            paint.color = ORANGE_DARK
            paint.typeface = Typeface.create("sans-serif", Typeface.BOLD)
            paint.textSize = 24f
            paint.textAlign = Paint.Align.CENTER
            canvas.drawText(
                ellipsize(fact, paint, width - 22f),
                left + width / 2,
                y + 46f,
                paint,
            )
        }
        paint.textAlign = Paint.Align.LEFT
    }

    private fun drawWrappedText(
        canvas: Canvas,
        text: String,
        x: Float,
        baselineY: Float,
        maxWidth: Float,
        lineHeight: Float,
        maxLines: Int,
        paint: Paint,
    ): Float {
        var remaining = text.trim()
        var y = baselineY
        repeat(maxLines) { lineIndex ->
            if (remaining.isEmpty()) return y
            val count = paint.breakText(remaining, true, maxWidth, null).coerceAtLeast(1)
            val hasMore = count < remaining.length
            val rawLine = remaining.take(count).trimEnd()
            val line = if (lineIndex == maxLines - 1 && hasMore) {
                ellipsize(rawLine + remaining.drop(count), paint, maxWidth)
            } else {
                rawLine
            }
            canvas.drawText(line, x, y, paint)
            remaining = remaining.drop(count).trimStart()
            if (lineIndex < maxLines - 1 && remaining.isNotEmpty()) y += lineHeight
            if (lineIndex == maxLines - 1 || remaining.isEmpty()) return y
        }
        return y
    }

    private fun ellipsize(text: String, paint: Paint, maxWidth: Float): String {
        if (paint.measureText(text) <= maxWidth) return text
        val ellipsis = "…"
        val allowed = (maxWidth - paint.measureText(ellipsis)).coerceAtLeast(0f)
        val count = paint.breakText(text, true, allowed, null).coerceAtLeast(0)
        return text.take(count).trimEnd() + ellipsis
    }

    private companion object {
        const val CARD_WIDTH = 1080
        const val CARD_HEIGHT = 1440
        const val PNG_QUALITY = 100
        const val MARGIN = 56f
        val CREAM = Color.rgb(255, 248, 240)
        val WHITE = Color.rgb(255, 255, 255)
        val ORANGE = Color.rgb(255, 105, 43)
        val ORANGE_DARK = Color.rgb(191, 67, 20)
        val SOFT_ORANGE = Color.rgb(255, 231, 213)
        val INK = Color.rgb(47, 34, 27)
        val MUTED = Color.rgb(105, 87, 77)
        val DEMO_BACKGROUND = Color.rgb(255, 224, 224)
        val DEMO_INK = Color.rgb(164, 35, 35)
    }
}
