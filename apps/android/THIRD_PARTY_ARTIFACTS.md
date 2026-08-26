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

## Alibaba Cloud Fusion Authentication Android SDK

- Purpose: mobile-number verification for the Alibaba Cloud global Fusion
  Authentication flow.
- Publisher: Alibaba Cloud Computing (Beijing) Co., Ltd.
- Official product console: <https://dypns.console.aliyun.com/>
- Official Android integration reference:
  <https://help.aliyun.com/zh/pnvs/developer-reference/the-android-client-access-3>
- Official server token API:
  <https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-getfusionauthtoken>
- Download route: Alibaba Cloud Number Authentication console, **API & SDK**,
  product **Fusion Authentication**, endpoint **APP**, platform **Android**,
  standard version.
- Archive: `fusionAuthSDK_APP_Android_v1.2.15_operator_ui_log_static.zip`
  - Size: `10,484,896` bytes
  - MD5: `FCF7AC166A39B2782A4E7933C0F50226`
- Required local AAR: `fusionauth-1.2.15-online-release.aar`
  - SHA-256: `706653407DCD94C9214AA4277E14476723672E27AA998ADBF9E612EC038857FC`
  - Local path: `apps/android/.local/fusion-auth/fusionauth-1.2.15-online-release.aar`
- Required risk AAR: `umeng-common-9.5.6.aar`
  - Size: `547,611` bytes
  - SHA-256: `89C22AD4D6F761ABB14FB79CB0BE051C2DD5C59ADD655B808E2A9511FD7D40E4`
  - Local path: `apps/android/.local/fusion-auth/umeng-common-9.5.6.aar`
- Required risk AAR: `umeng-asms-v1.8.0.aar`
  - Size: `981,801` bytes
  - SHA-256: `35021A4A64B12568F6804193E05D197420BE577622C6ED402FF7B736CE17E324`
  - Local path: `apps/android/.local/fusion-auth/umeng-asms-v1.8.0.aar`

The archive, AAR, demo, signing material, and build outputs must not be
committed. Prepare the pinned AAR from an official archive with:

```powershell
.\scripts\prepare-fusion-auth-sdk.ps1 `
  -SdkZipPath 'C:\path\to\fusionAuthSDK_APP_Android_v1.2.15_operator_ui_log_static.zip'
```

The preparation script checks every ZIP entry for path traversal and symbolic
links, verifies the archive plus all three pinned AAR hashes, and transactionally
prepares only those three local artifacts with full rollback on any intermediate
failure. It never extracts or adopts the
bundled demo or demo keystore.

The selected global strategy contains Alibaba Cloud's device-risk node. The
two bundled Umeng risk libraries are therefore required together with the main
AAR; a partial set fails configuration. Ordinary Alpha, Debug, Fixture, Release
and CI still compile the no-op implementation. A device-testable Fusion Alpha
must be requested explicitly with
`-PCHISHENME_REQUIRE_FUSION_SDK=true`; the build fails instead of silently
falling back when any local artifact is missing or has the wrong hash.

Binary Manifest inspection shows that the pinned AAR set contributes
`com.google.android.gms.permission.AD_ID`, `CHANGE_WIFI_STATE`,
`RECEIVE_USER_PRESENT`, `ACCESS_WIFI_STATE`, and `CHANGE_NETWORK_STATE`; the
Fusion-only source set adds `READ_PHONE_STATE`. The explicitly requested Fusion
Alpha therefore contains all six permissions, while ordinary no-op variants
contain none of them. The consent disclosure names the corresponding telephone,
advertising identifier, Wi-Fi/network-state and device-unlock access and limits
them to authentication connectivity, device-risk detection and frequency
control, never ad delivery or profiling. Do not remove an upstream permission
blindly: whether the pinned risk node functions without it must be established
by the provider and an ARM64/SIM device review before changing the manifest
boundary.

The pinned number-auth dependency exposes the four carrier agreement URLs in
`com.mobile.auth.gatewayauth.Constant`. The Fusion-only manifest registers a
non-exported `com.fusion.auth` handler whose WebView accepts only those exact
HTTPS hosts, disables JavaScript, file/content access and mixed content, and
destroys the WebView with the Activity. Redirects or subresources outside the
pinned host set fail closed. Carrier-agreement navigation and the return path
remain mandatory physical-device acceptance checks.

The upstream binary has a version-metadata inconsistency: the console,
archive, and AAR filename identify version 1.2.15, while metadata embedded in
the supplied AAR still identifies version 1.2.8. Keep the binary byte-for-byte
unchanged and identify it by both hashes above. A replacement SDK requires a
fresh binary, API, manifest, privacy, and device review.

The supplied AAR set has no `x86_64` native library. Emulator success is therefore
not a release claim and an x86_64-only emulator is not an acceptance device.
Before enabling the flow for users, complete the privacy-consent gate and
exercise initialization, token refresh, success, cancellation, failure, and
recovery on an ARM64 physical Android device. The app must not initialize the
SDK before the user accepts the privacy policy, and production diagnostics
must not log the Fusion token, verification token, phone number, or carrier
result. The global strategy's phone-risk/SMS fallback also treats
`onGetPhoneNumberForVerification` as a required callback. Android 1.0 returns
an empty value rather than guessing or persisting a phone number; every strategy
branch that needs an app-supplied number remains a physical-device release
blocker until an ARM64 device with a real SIM proves the configured path can
complete or fail closed.

The provider requires `onSDKTokenUpdate`, but its callback cannot synchronously
obtain a newly server-authorized token through the current API boundary. The
adapter therefore fails the active scene and requires a fresh user-initiated
flow instead of reusing an expired token or returning a fake refresh. Seamless
refresh/recovery is not claimed and is a physical-device release blocker.
