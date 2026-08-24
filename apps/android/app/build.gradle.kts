import com.chishenme.buildlogic.ReleaseApiUrlPolicy
import com.chishenme.buildlogic.QqAppIdPolicy
import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("org.jetbrains.kotlin.kapt")
    id("com.google.dagger.hilt.android")
}

val releaseApiUrl = providers.gradleProperty("CHISHENME_API_BASE_URL")
val alphaApiUrl = providers.gradleProperty("CHISHENME_ALPHA_API_BASE_URL")
val wechatAppId = providers.gradleProperty("CHISHENME_WECHAT_APP_ID")
    .orElse("")
    .get()
    .trim()
if (wechatAppId.isNotEmpty() && !wechatAppId.matches(Regex("^wx[0-9a-fA-F]{16}$"))) {
    throw GradleException("CHISHENME_WECHAT_APP_ID 必须为空或符合 wx + 16 位十六进制字符格式")
}
val debugWechatAppId = providers.gradleProperty("CHISHENME_DEBUG_WECHAT_APP_ID")
    .orElse("")
    .get()
    .trim()
val alphaWechatAppId = providers.gradleProperty("CHISHENME_ALPHA_WECHAT_APP_ID")
    .orElse("")
    .get()
    .trim()
listOf(
    "CHISHENME_DEBUG_WECHAT_APP_ID" to debugWechatAppId,
    "CHISHENME_ALPHA_WECHAT_APP_ID" to alphaWechatAppId,
).forEach { (name, value) ->
    if (value.isNotEmpty() && !value.matches(Regex("^wx[0-9a-fA-F]{16}$"))) {
        throw GradleException("$name 必须为空或符合 wx + 16 位十六进制字符格式")
    }
}
val qqAppId = providers.gradleProperty("CHISHENME_QQ_APP_ID")
    .orElse("")
    .get()
    .trim()
if (!QqAppIdPolicy.isAllowedOrDisabled(qqAppId)) {
    throw GradleException("CHISHENME_QQ_APP_ID 必须为空或为 5 至 16 位、不以 0 开头的纯数字 AppID")
}
val debugQqAppId = providers.gradleProperty("CHISHENME_DEBUG_QQ_APP_ID")
    .orElse("")
    .get()
    .trim()
val alphaQqAppId = providers.gradleProperty("CHISHENME_ALPHA_QQ_APP_ID")
    .orElse("")
    .get()
    .trim()
listOf(
    "CHISHENME_DEBUG_QQ_APP_ID" to debugQqAppId,
    "CHISHENME_ALPHA_QQ_APP_ID" to alphaQqAppId,
).forEach { (name, value) ->
    if (!QqAppIdPolicy.isAllowedOrDisabled(value)) {
        throw GradleException("$name 必须为空或为 5 至 16 位、不以 0 开头的纯数字 AppID")
    }
}
val debugApiUrl = providers.gradleProperty("CHISHENME_DEBUG_API_BASE_URL")
    .orElse("http://127.0.0.1:3001/")
    .get()
    .trim()
val parsedDebugApiUrl = runCatching { URI(debugApiUrl) }.getOrNull()
val debugHost = parsedDebugApiUrl?.host?.lowercase()
val debugUrlHasNoExtras = parsedDebugApiUrl?.userInfo == null &&
    parsedDebugApiUrl?.query == null &&
    parsedDebugApiUrl?.fragment == null
val isLoopbackDebugHttp = parsedDebugApiUrl?.scheme.equals("http", ignoreCase = true) &&
    debugHost != null &&
    debugHost in setOf("127.0.0.1", "localhost") &&
    (parsedDebugApiUrl?.port ?: -1) in 1..65_535
val isHttpsDebugApi = parsedDebugApiUrl?.scheme.equals("https", ignoreCase = true) &&
    !debugHost.isNullOrBlank()
if (
    parsedDebugApiUrl == null ||
    !debugUrlHasNoExtras ||
    !debugApiUrl.endsWith("/") ||
    (!isLoopbackDebugHttp && !isHttpsDebugApi)
) {
    throw GradleException(
        "Debug API 地址只允许带显式端口的 http://127.0.0.1/localhost，或有效 HTTPS 地址；" +
            "并且必须以 / 结尾且不含 user-info、query 或 fragment",
    )
}
val configuredReleaseApiUrl = releaseApiUrl
    .orElse("https://api.example.invalid/")
    .get()
    .trim()
val configuredAlphaApiUrl = alphaApiUrl
    .orElse("https://api.example.invalid/")
    .get()
    .trim()
val releaseStoreFile = providers.environmentVariable("CHISHENME_RELEASE_STORE_FILE")
val releaseStorePassword = providers.environmentVariable("CHISHENME_RELEASE_STORE_PASSWORD")
val releaseKeyAlias = providers.environmentVariable("CHISHENME_RELEASE_KEY_ALIAS")
val releaseKeyPassword = providers.environmentVariable("CHISHENME_RELEASE_KEY_PASSWORD")
val hasReleaseSigning = listOf(
    releaseStoreFile,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { it.isPresent }

android {
    namespace = "com.chishenme.app"
    compileSdk = 36

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStoreFile.get())
                storePassword = releaseStorePassword.get()
                keyAlias = releaseKeyAlias.get()
                keyPassword = releaseKeyPassword.get()
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = true
            }
        }
    }

    defaultConfig {
        applicationId = "com.chishenme.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        versionName = "0.1.2-alpha01"

        // WeChat AppID is a public application identifier, not a provider
        // secret. An empty value is intentional: every variant then fails
        // closed without manufacturing a test identity.
        buildConfigField("String", "CHISHENME_WECHAT_APP_ID", "\"$wechatAppId\"")
        // QQ AppID is public but package/signature-bound. Empty means the
        // OpenSDK activities and client entry stay disabled for this APK.
        buildConfigField("String", "CHISHENME_QQ_APP_ID", "\"$qqAppId\"")
        // Android 1.0 ships without any share entry point. This is deliberately
        // a compile-time constant, not a Gradle property or remote switch.
        buildConfigField("boolean", "SHARE_FEATURE_ENABLED", "false")

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        manifestPlaceholders["wechatSdkEnabled"] = wechatAppId.isNotEmpty().toString()
        manifestPlaceholders["qqSdkEnabled"] = qqAppId.isNotEmpty().toString()
        manifestPlaceholders["qqCallbackScheme"] = if (qqAppId.isNotEmpty()) {
            "tencent$qqAppId"
        } else {
            "tencent-disabled"
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            // The debug network-security overlay permits cleartext only to
            // localhost/127.0.0.1 for the adb reverse workflow.
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            // `adb reverse tcp:3001 tcp:3001` works consistently for the
            // official emulator, third-party emulators and physical devices.
            buildConfigField("String", "API_BASE_URL", "\"$debugApiUrl\"")
            // A production AppID is package/signature-bound and must never be
            // silently reused by the .debug application. Configure a separately
            // approved debug mobile application or keep this variant disabled.
            buildConfigField("String", "CHISHENME_WECHAT_APP_ID", "\"$debugWechatAppId\"")
            buildConfigField("String", "CHISHENME_QQ_APP_ID", "\"$debugQqAppId\"")
            manifestPlaceholders["wechatSdkEnabled"] = debugWechatAppId.isNotEmpty().toString()
            manifestPlaceholders["qqSdkEnabled"] = debugQqAppId.isNotEmpty().toString()
            manifestPlaceholders["qqCallbackScheme"] = if (debugQqAppId.isNotEmpty()) {
                "tencent$debugQqAppId"
            } else {
                "tencent-disabled"
            }
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            buildConfigField("String", "API_BASE_URL", "\"$configuredReleaseApiUrl\"")
            signingConfig = signingConfigs.findByName("release")
        }
        create("alpha") {
            // An internal, minified build for realistic startup and device
            // testing. It is deliberately a separate debug-signed package and
            // never bypasses the release endpoint/signing publication gate.
            initWith(getByName("release"))
            applicationIdSuffix = ".alpha"
            versionNameSuffix = "-internal"
            isDebuggable = false
            signingConfig = signingConfigs.getByName("debug")
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            buildConfigField("String", "API_BASE_URL", "\"$configuredAlphaApiUrl\"")
            // Alpha also has a distinct package/signature identity. It remains
            // fail-closed unless the platform has approved dedicated AppIDs.
            buildConfigField("String", "CHISHENME_WECHAT_APP_ID", "\"$alphaWechatAppId\"")
            buildConfigField("String", "CHISHENME_QQ_APP_ID", "\"$alphaQqAppId\"")
            manifestPlaceholders["wechatSdkEnabled"] = alphaWechatAppId.isNotEmpty().toString()
            manifestPlaceholders["qqSdkEnabled"] = alphaQqAppId.isNotEmpty().toString()
            manifestPlaceholders["qqCallbackScheme"] = if (alphaQqAppId.isNotEmpty()) {
                "tencent$alphaQqAppId"
            } else {
                "tencent-disabled"
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "META-INF/LICENSE.md",
            "META-INF/LICENSE-notice.md",
        )
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

val validateReleaseConfiguration = tasks.register("validateReleaseConfiguration") {
    group = "verification"
    description = "Fails closed when release endpoint or signing material is missing."
    doLast {
        val rawUrl = releaseApiUrl.orNull?.trim()
            ?: throw GradleException("Release 构建必须通过 -PCHISHENME_API_BASE_URL 配置 API 地址")
        if (!ReleaseApiUrlPolicy.isAllowed(rawUrl)) {
            throw GradleException(
                "Release API 地址必须是以 / 结尾的公网 HTTPS URL，且不得包含 user-info、" +
                    "query、fragment、localhost、回环/私网/保留地址或保留域名",
            )
        }
        if (!hasReleaseSigning) {
            throw GradleException("Release 构建缺少 CHISHENME_RELEASE_* 签名环境变量")
        }
        if (!file(releaseStoreFile.get()).isFile) {
            throw GradleException("Release 签名文件不存在")
        }
    }
}

val validateAlphaConfiguration = tasks.register("validateAlphaConfiguration") {
    group = "verification"
    description = "Fails closed when the Alpha endpoint is missing or is not public HTTPS."
    doLast {
        val rawUrl = alphaApiUrl.orNull?.trim()
            ?: throw GradleException(
                "Alpha 构建必须通过 -PCHISHENME_ALPHA_API_BASE_URL 配置 API 地址",
            )
        if (!ReleaseApiUrlPolicy.isAllowed(rawUrl)) {
            throw GradleException(
                "Alpha API 地址必须是以 / 结尾的公网 HTTPS URL，且不得包含 user-info、" +
                    "query、fragment、localhost、回环/私网/保留地址或保留域名",
            )
        }
    }
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    dependsOn(validateReleaseConfiguration)
}

tasks.matching { it.name == "preAlphaBuild" }.configureEach {
    dependsOn(validateAlphaConfiguration)
}

kapt {
    correctErrorTypes = true
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.04.01")

    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.navigation:navigation-compose:2.9.0")

    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    // Keep the startup/runtime classpath small. The extended artifact contains
    // thousands of generated icon classes; this app uses only the compact core
    // set plus a few app-local vectors.
    implementation("androidx.compose.material:material-icons-core")

    implementation("androidx.datastore:datastore-preferences:1.1.7")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.jakewharton.retrofit:retrofit2-kotlinx-serialization-converter:1.0.0")
    implementation("io.coil-kt:coil-compose:2.7.0")

    implementation("com.google.dagger:hilt-android:2.56.2")
    kapt("com.google.dagger:hilt-compiler:2.56.2")
    implementation("androidx.hilt:hilt-navigation-compose:1.2.0")

    // Fixed official WeChat OpenSDK artifact. Never use a dynamic version:
    // OAuth callback and privacy behavior must be reproducible per release.
    implementation("com.tencent.mm.opensdk:wechat-sdk-android:6.8.40")

    // Tencent stopped publishing current QQ OpenSDK releases to a supported
    // repository. This exact official Lite JAR is integrity-pinned in
    // apps/android/THIRD_PARTY_ARTIFACTS.md.
    implementation(files("libs/open_sdk_3.5.19_r9483ffc7_lite.jar"))

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")

    androidTestImplementation(composeBom)
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.test.espresso:espresso-intents:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
