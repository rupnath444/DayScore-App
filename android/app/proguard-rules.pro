# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# ============ SECURITY: Keep Firebase & Capacitor intact ============
# Firebase needs these classes for runtime reflection
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }
-keep class com.google.common.** { *; }

# Capacitor needs these for native bridging
-keep class com.capacitorjs.** { *; }
-keep class android.webkit.JavascriptInterface { *; }

# Keep Kotlin stdlib - needed for runtime
-keep class kotlin.** { *; }
-dontwarn kotlin.**
-keep class kotlinx.** { *; }
-dontwarn kotlinx.**

# Keep custom Firebase security rules validation
-keep class com.rupnath.dayscore.** { *; }

# OBFUSCATE: Everything else gets obfuscated for security
-repackageclasses 'a'
-allowaccessmodification
-obfuscationdictionary proguard-obfuscation-dict.txt

# ============ SECURITY: Debugging ============
# Strip line number info from release builds (reduces binary size & hides code structure)
-renamesourcefileattribute SourceFile
-keepattributes SourceFile

# Keep manifest classes
-keepclasseswithmembernames class * {
    native <methods>;
}

# Keep custom app components
-keepclasseswithmembers class * {
    public <init>(android.content.Context, android.util.AttributeSet);
}

# WARNING: Removing this can break Firebase token verification
-keepattributes Signature
-keepattributes *Annotation*

# ============ SECURITY: Crash reporting & logs ============
# Keep exception classes for crash logs
-keep public class * extends java.lang.Exception { *; }
-keep public class * extends java.lang.Throwable { *; }

