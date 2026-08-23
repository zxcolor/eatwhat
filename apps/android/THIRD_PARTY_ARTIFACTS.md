# Android third-party binary artifacts

This file records binaries that cannot be resolved from Google Maven or Maven
Central. Do not replace them with JCenter, an unofficial mirror, or a dynamic
dependency.

## Tencent QQ Connect Android OpenSDK (Lite)

- Purpose: QQ login and logged-in account binding only (no QQ sharing).
- Publisher: Shenzhen Tencent Computer Systems Company Limited.
- Official download page: <https://wiki.connect.qq.com/sdk%E4%B8%8B%E8%BD%BD>
- Official integration/privacy page: <https://wiki.connect.qq.com/sdk%E6%8E%A5%E5%85%A5%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E%E6%96%87%E6%A1%A3>
- Official final archive URL: <https://tangram-1251316161.file.myqcloud.com/files/20260414/143310b667ece8922594fbe866dabdef.zip>
- Downloaded: 2026-08-21 08:39:44 +08:00.
- Official page release label: Android SDK 3.5.19, updated 2026-04-14.
- Archive: `143310b667ece8922594fbe866dabdef.zip`
  - Size: `1,562,363` bytes
  - SHA-256: `6272D4123D8327400A655C48F1FB7EB24B83FD5BEEB527951ED100B219192B9B`
- Vendored file: `app/libs/open_sdk_3.5.19_r9483ffc7_lite.jar`
  - Size: `333,248` bytes
  - SHA-256: `9D57FE61FF9026D34AC84BC63DC719F61DA6AA40533A299CC6F73D4CE9DF7AF8`

Package inspection found the expected `com.tencent.tauth.Tencent`,
`IUiListener`, `AuthActivity`, and `com.tencent.connect.common.AssistActivity`
classes. The public signatures include `setIsPermissionGranted(boolean)`,
three-argument `createInstance`, `login(Activity, String, IUiListener)`, and
`onActivityResultData`.

Tencent's archive has an upstream metadata inconsistency: the official page,
archive date and JAR filename identify 3.5.19, while the embedded
`Constants.SDK_VERSION` and bundled demo APK still report `3.5.18.lite` /
`3.5.18`. The JAR is kept byte-for-byte unchanged and identified by the hashes
above; the discrepancy must be rechecked with Tencent before public release.

The official JAR contains legacy support-v4 references, so the Android project
enables Jetifier for this pinned artifact. It carries no Android manifest of its
own. The app declares only the two login activities, `INTERNET` plus
`ACCESS_NETWORK_STATE`, and exact QQ/TIM package visibility. It does not adopt
the demo's storage or Wi-Fi permissions and does not expose an additional file
root/provider.

The existing FileProvider authority is also referenced by the pinned SDK's
three-argument `createInstance`, but Android 1.0 exposes no restaurant-share or
QQ-share entry point. `SHARE_FEATURE_ENABLED` is a single compile-time constant
fixed to `false`; no Gradle property or remote configuration can enable the
sealed share-card implementation. Keeping this compatibility wiring must not be
interpreted as permission to broaden the provider paths or call QQ publishing
APIs. Any 2.0 reactivation requires a new SDK, privacy, security, and data-rights
review.

The JAR also performs one binary compatibility probe against the removed
OkHttp 3 internal method `okhttp3.internal.Version.userAgent()`. All public
OkHttp calls used by this JAR remain available in the app's pinned OkHttp
4.12.0 dependency. The app therefore supplies one narrowly scoped bridge that
returns the exact `okhttp/3` prefix checked by the SDK. R8 is not configured to
hide a missing class: the Alpha build must resolve and retain this bridge, so a
future SDK or OkHttp upgrade fails visibly during verification instead of at
login time.
