# kotlinx.serialization models are generated at compile time; Retrofit reads annotations.
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations,AnnotationDefault
-keep class kotlin.Metadata { *; }

# The pinned QQ OpenSDK Lite JAR ships without consumer ProGuard rules and uses
# manifest entry points plus internal reflective dispatch. Keep its small,
# integrity-pinned namespace stable in the minified Alpha artifact.
-keep class com.tencent.** { *; }

# OpenSDK 3.5.19 Lite probes this removed OkHttp 3 internal helper by name.
# The project supplies the narrow compatibility bridge; it must survive R8.
-keep class okhttp3.internal.Version {
    public static java.lang.String userAgent();
}
