# R8 keep rules for the release build.
# OkHttp, Media3, Compose, and kotlinx-coroutines ship their own consumer rules;
# we only need quickjs-kt (JNI) and kotlinx.serialization here.

# ---- quickjs-kt: JNI bridge reached via native methods / reflection ----
-keep class com.dokar.quickjs.** { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}

# ---- kotlinx.serialization ----
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

# Keep generated serializers and the serializer() lookups everywhere.
-keep,includedescriptorclasses class **$$serializer { *; }
-keepclassmembers @kotlinx.serialization.Serializable class ** {
    *** Companion;
    *** INSTANCE;
}
-keepclasseswithmembers class ** {
    kotlinx.serialization.KSerializer serializer(...);
}

# The engine snapshot / frame / command / net-envelope models are @Serializable
# and decoded from JSON the QuickJS engine emits, so keep them intact.
-keep class com.hexstacker.core.model.** { *; }
-keep class com.hexstacker.core.net.** { *; }

# ---- kotlinx-coroutines: keep the atomic field updaters (belt-and-suspenders) ----
-keepclassmembers class kotlinx.coroutines.** {
    volatile <fields>;
}
-dontwarn kotlinx.coroutines.**
