package com.chishenme.app.feature.detail

import com.chishenme.app.data.remote.RecommendationResult
import java.io.File
import java.io.FileOutputStream

internal class RestaurantShareCardGenerator(
    private val renderer: RestaurantShareCardPngRenderer = RestaurantShareCardRenderer(),
) {
    /**
     * Returns a private PNG only when the server allows sharing and rendering
     * completes. A partial file is removed on every failure path.
     */
    fun generate(cacheDirectory: File, result: RecommendationResult): File? {
        val content = RestaurantShareCardContentFactory.create(result) ?: return null
        val outputFile = RestaurantShareCardStore(cacheDirectory).createOutputFile()
        return try {
            val rendered = FileOutputStream(outputFile).use { output ->
                renderer.renderPng(content, output)
            }
            outputFile.takeIf { rendered && it.isFile && it.length() > 0L }
                ?: run {
                    outputFile.delete()
                    null
                }
        } catch (_: Exception) {
            outputFile.delete()
            null
        } catch (_: OutOfMemoryError) {
            outputFile.delete()
            null
        }
    }
}
