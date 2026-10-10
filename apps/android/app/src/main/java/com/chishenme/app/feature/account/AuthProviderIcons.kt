package com.chishenme.app.feature.account

import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/** Decorative provider mark; the surrounding action supplies its accessible label. */
@Composable
fun WechatAuthIcon(modifier: Modifier = Modifier) {
    Icon(
        imageVector = WechatAuthVector,
        contentDescription = null,
        modifier = modifier,
        tint = Color.Unspecified,
    )
}

/** Decorative provider mark; the surrounding action supplies its accessible label. */
@Composable
fun QqAuthIcon(modifier: Modifier = Modifier) {
    Icon(
        imageVector = QqAuthVector,
        contentDescription = null,
        modifier = modifier,
        tint = Color.Unspecified,
    )
}

/*
 * Source geometry: Tencent TDesign Icons, MIT License.
 * WeChat: https://github.com/Tencent/tdesign-icons/blob/develop/svg/logo-wechat-stroke-filled.svg
 * QQ silhouette: https://github.com/Tencent/tdesign-icons/blob/develop/svg/logo-qq.svg
 * Retrieved 2026-09-16. The WeChat paths are unchanged and use a single #07C160 fill.
 * QQ keeps the source silhouette, with locally drawn flat-color facial, scarf,
 * belly and foot details to remain recognisable in compact authentication actions.
 * No provider SDK or remote asset is loaded by these composables.
 *
 * Copyright (c) 2021-present TDesign
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

private val WechatAuthVector: ImageVector by lazy(LazyThreadSafetyMode.NONE) {
    providerVector("WechatAuth").apply {
        solidPath(
            color = Color(0xFF07C160),
            data = "M16.75 7.71395C16.8969 7.71395 17.0433 7.71723 17.1892 7.72373" +
                "C16.1727 4.59379 12.7794 2.29395 8.75 2.29395" +
                "C3.91751 2.29395 0 5.60188 0 9.68242" +
                "C0 11.9053 1.16251 13.8989 3.00217 15.2533L2.64999 17.9649L5.4876 16.5403" +
                "C6.336 16.8283 7.25019 17.0073 8.20586 17.0568" +
                "C8.07141 16.5205 8 15.9584 8 15.3749" +
                "C8 10.9242 12.1557 7.71395 16.75 7.71395Z" +
                "M5.99999 8.04394C5.4477 8.04394 4.99999 7.59623 4.99999 7.04395" +
                "C4.99999 6.49166 5.4477 6.04394 5.99999 6.04394" +
                "C6.55227 6.04394 6.99999 6.49166 6.99999 7.04395" +
                "C6.99999 7.59623 6.55227 8.04394 5.99999 8.04394Z" +
                "M11.5 8.05127C10.9477 8.05127 10.5 7.60355 10.5 7.05127" +
                "C10.5 6.49898 10.9477 6.05127 11.5 6.05127" +
                "C12.0523 6.05127 12.5 6.49898 12.5 7.05127" +
                "C12.5 7.60355 12.0523 8.05127 11.5 8.05127Z",
        )
        solidPath(
            color = Color(0xFF07C160),
            data = "M24 15.3749C24 17.0774 23.1874 18.6185 21.8739 19.7336" +
                "V22.5064L19.4364 21.0991C18.6056 21.3809 17.6991 21.5359 16.75 21.5359" +
                "C12.7459 21.5359 9.5 18.7776 9.5 15.3749" +
                "C9.5 11.9723 12.7459 9.21395 16.75 9.21395" +
                "C20.7541 9.21395 24 11.9723 24 15.3749Z" +
                "M13.31 13.3719C13.31 13.9242 13.7577 14.3719 14.31 14.3719" +
                "C14.8623 14.3719 15.31 13.9242 15.31 13.3719" +
                "C15.31 12.8196 14.8623 12.3719 14.31 12.3719" +
                "C13.7577 12.3719 13.31 12.8196 13.31 13.3719Z" +
                "M18.19 13.3719C18.19 13.9242 18.6377 14.3719 19.19 14.3719" +
                "C19.7423 14.3719 20.19 13.9242 20.19 13.3719" +
                "C20.19 12.8196 19.7423 12.3719 19.19 12.3719" +
                "C18.6377 12.3719 18.19 12.8196 18.19 13.3719Z",
        )
    }.build()
}

private val QqAuthVector: ImageVector by lazy(LazyThreadSafetyMode.NONE) {
    val black = Color(0xFF171717)
    val yellow = Color(0xFFFFC02B)
    val red = Color(0xFFF53237)
    providerVector("QqAuth").apply {
        solidPath(
            color = black,
            data = "M20.2145 14.6548C20.0273 14.0523 19.7714 13.3498 19.513 12.675" +
                "L18.5692 10.3156C18.5692 10.2884 18.5818 9.82435 18.5818 9.58475" +
                "C18.5818 5.55233 16.6781 1.50052 11.9971 1.5" +
                "C7.3161 1.49948 5.41184 5.55233 5.41184 9.58475" +
                "C5.41184 9.82383 5.42389 10.2884 5.42442 10.3156L4.48067 12.675" +
                "C4.22167 13.3498 3.96633 14.0523 3.77916 14.6548" +
                "C2.88784 17.5279 3.17568 18.717 3.39589 18.7443" +
                "C3.86776 18.8015 5.23567 16.581 5.23567 16.581" +
                "C5.23567 17.8666 5.89734 19.5444 7.32921 20.7561" +
                "C6.7939 20.9212 6.13747 21.1755 5.71541 21.4864" +
                "C5.33633 21.7664 5.38352 22.0516 5.45325 22.168" +
                "C5.75368 22.6745 10.6009 22.4915 12.0002 22.3337" +
                "C13.3996 22.491 18.2468 22.6745 18.5467 22.168" +
                "C18.6148 22.0527 18.662 21.7674 18.2845 21.4864" +
                "C17.8651 21.175 17.2055 20.9207 16.6697 20.7555" +
                "C18.1015 19.5444 18.7632 17.8666 18.7632 16.581" +
                "C18.7632 16.581 20.1306 18.8015 20.603 18.7443" +
                "C20.8195 18.7181 21.1089 17.529 20.2145 14.6548Z",
        )
        solidPath(
            color = yellow,
            data = "M7.55 20.82C8.65 21.25 9.65 21.47 11.28 21.57L11.55 22.15" +
                "C9.85 22.28 6.01 22.36 5.68 22.07C5.55 21.83 6.36 21.2 7.55 20.82Z" +
                "M16.45 20.82C15.35 21.25 14.35 21.47 12.72 21.57L12.45 22.15" +
                "C14.15 22.28 17.99 22.36 18.32 22.07C18.45 21.83 17.64 21.2 16.45 20.82Z",
        )
        solidPath(
            color = Color.White,
            data = "M7.44 11.7C6.97 12.93 6.65 14.7 6.86 16.25" +
                "C7.17 19.19 9.09 20.95 12 20.95C14.91 20.95 16.83 19.19 17.14 16.25" +
                "C17.35 14.7 17.03 12.93 16.56 11.7Z" +
                "M10.05 4.82C9.14 4.82 8.65 5.65 8.65 6.84" +
                "C8.65 8.05 9.14 8.75 10.05 8.75C10.96 8.75 11.46 8.05 11.46 6.84" +
                "C11.46 5.65 10.96 4.82 10.05 4.82Z" +
                "M13.95 4.82C13.04 4.82 12.54 5.65 12.54 6.84" +
                "C12.54 8.05 13.04 8.75 13.95 8.75C14.86 8.75 15.35 8.05 15.35 6.84" +
                "C15.35 5.65 14.86 4.82 13.95 4.82Z",
        )
        solidPath(
            color = black,
            data = "M10.2 5.89C9.79 5.89 9.59 6.32 9.59 6.94" +
                "C9.59 7.56 9.79 7.94 10.2 7.94C10.61 7.94 10.82 7.56 10.82 6.94" +
                "C10.82 6.32 10.61 5.89 10.2 5.89Z" +
                "M13.8 5.89C13.39 5.89 13.18 6.32 13.18 6.94" +
                "C13.18 7.56 13.39 7.94 13.8 7.94C14.21 7.94 14.41 7.56 14.41 6.94" +
                "C14.41 6.32 14.21 5.89 13.8 5.89Z",
        )
        solidPath(
            color = yellow,
            data = "M7.67 9.16C8.13 8.72 10.04 8.39 12 8.39" +
                "C13.96 8.39 15.87 8.72 16.33 9.16C16.8 9.61 14.78 10.5 12 10.5" +
                "C9.22 10.5 7.2 9.61 7.67 9.16Z",
        )
        solidPath(
            color = red,
            data = "M5.83 10.68C8.56 12.15 15.44 12.15 18.17 10.68L18.82 12.24" +
                "C15.56 13.96 8.44 13.96 5.18 12.24Z" +
                "M7.55 13.02L9.59 13.42L9.25 16.32L7.17 15.89Z",
        )
    }.build()
}

private fun providerVector(name: String) = ImageVector.Builder(
    name = name,
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f,
)

private fun ImageVector.Builder.solidPath(color: Color, data: String) {
    addPath(
        pathData = PathParser().parsePathString(data).toNodes(),
        fill = SolidColor(color),
    )
}
