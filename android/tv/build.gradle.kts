// :tv — the Android TV app (Leanback). Renders natively (Jetpack Compose for TV
// + android.graphics.Canvas) and drives the canonical game engine that runs in
// QuickJS inside :core. AGP 9 compiles Kotlin built-in (no separate kotlin
// plugin needed).
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.roborazzi)
}

// Sync the canonical engine bundle (dist/partycore.js, the HexCore iife produced
// by `npm run build` at the repo root) into the app's assets at build time, so
// the app loads the EXACT same engine artifact the web/tests use. Git-ignored,
// regenerated, cannot drift — the Gradle analog of appletv/scripts/sync-engine.sh.
val engineBundleAssets = layout.buildDirectory.dir("generated/engineAssets")
val syncEngineBundle by tasks.registering(Copy::class) {
    val bundle = rootProject.layout.projectDirectory.file("../dist/partycore.js")
    from(bundle)
    into(engineBundleAssets)
    doFirst {
        if (!bundle.asFile.exists()) {
            throw GradleException(
                "Missing ${bundle.asFile}. Run `npm run build` at the repo root first.",
            )
        }
    }
}

android {
    namespace = "com.hexstacker.tv"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.hexstacker.tv"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        // Real Android TVs are arm64-v8a; x86_64 is for the emulator. Dropping the
        // legacy armeabi-v7a + x86 quickjs .so halves the native payload.
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Debug-signed so the release build is installable for testing; replace
            // with a real release keystore before publishing.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = false
    }
    // Robolectric-backed screenshot tests (Roborazzi) need the merged resources +
    // assets (Orbitron fonts, localized strings) on the JVM unit-test classpath.
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }
    // Plain File (not a Provider): AGP 9 disallows Provider in the legacy
    // SourceSet API. Ordering is carried by the preBuild dependency below.
    sourceSets["main"].assets.srcDir(engineBundleAssets.get().asFile)
}

kotlin {
    jvmToolchain(17)
}

tasks.named("preBuild") {
    dependsOn(syncEngineBundle)
}

// The screenshot tests derive their fixture data by running the canonical engine
// bundle (dist/partycore.js) in QuickJS on the Robolectric host JVM, exactly as
// :core:jvmTest does. Point them at the repo-root bundle by absolute path so the
// test is hermetic regardless of the working directory.
tasks.withType<Test>().configureEach {
    val repoRoot = rootProject.layout.projectDirectory.dir("..")
    systemProperty("hexcore.bundle", repoRoot.file("dist/partycore.js").asFile.absolutePath)
}

// :tv resolves the ANDROID variant of quickjs-kt transitively through :core, whose
// AAR only bundles Android ELF .so files — those can't load on the host JVM the
// Robolectric unit tests run on. Drop it from the unit-test runtime classpath and
// substitute the desktop-JVM variant (added as testImplementation below), which
// ships the host natives and exposes the identical com.dokar.quickjs.* API.
configurations.matching { it.name.endsWith("UnitTestRuntimeClasspath") }.configureEach {
    exclude(group = "io.github.dokar3", module = "quickjs-kt-android")
}

dependencies {
    implementation(project(":core"))

    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.tv.material)
    implementation(libs.androidx.lifecycle.runtime.compose)
    debugImplementation(libs.androidx.compose.ui.tooling)

    // Audio (Media3/ExoPlayer) + QR (ZXing)
    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.common)
    implementation(libs.zxing.core)
    implementation(libs.kotlinx.coroutines.android)
    // JSON types cross the :core Fastlane interface (JsonObject) + the WebRTC binding builds
    // signaling/ack envelopes; the runtime API only (no serialization compiler plugin needed).
    implementation(libs.kotlinx.serialization.json)

    // WebRTC fast-lane: prebuilt libwebrtc (org.webrtc.*) for low-latency P2P
    // controller input over an unreliable DataChannel, with the relay as fallback.
    implementation(libs.webrtc.sdk)

    // ── Screenshot tests (JVM, no emulator): Roborazzi renders the Compose screens
    // and the Canvas BoardRenderer under Robolectric's native-graphics mode and
    // writes PNGs for CI artifacts + golden diffing. `./gradlew :tv:recordRoborazziDebug`.
    testImplementation(composeBom)
    testImplementation(libs.junit)
    // Runs the canonical engine bundle in QuickJS on the host JVM to source the
    // cross-platform gallery fixtures (see GalleryFixtures test helper). The -jvm
    // variant carries the desktop natives the android AAR lacks.
    testImplementation(libs.quickjs.kt.jvm)
    testImplementation(libs.kotlinx.coroutines.core)
    testImplementation(libs.robolectric)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.androidx.compose.ui.test.junit4)
    // Supplies the empty ComponentActivity that createComposeRule() hosts content in.
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
