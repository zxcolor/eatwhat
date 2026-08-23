package okhttp3.internal;

/**
 * Narrow binary-compatibility bridge for Tencent QQ OpenSDK 3.5.19 Lite.
 *
 * <p>The official Lite JAR was compiled against OkHttp 3 and calls only
 * {@code Version.userAgent()} to reject non-OkHttp-3 implementations before it
 * constructs its client. The app pins OkHttp 4.12, whose public Java API used
 * by that JAR remains binary compatible, but OkHttp 4 removed this internal
 * helper. Keeping the bridge in one explicit class is safer than suppressing
 * R8's missing-class error and then crashing when the QQ SDK is initialized.
 */
public final class Version {
    private Version() {}

    public static String userAgent() {
        return "okhttp/3-compat";
    }
}
