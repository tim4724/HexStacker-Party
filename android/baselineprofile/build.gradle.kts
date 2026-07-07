// :baselineprofile — generates the app-specific baseline profile for :tv
// (launch → lobby entrance is the hot path; see BaselineProfileGenerator).
// Run on a Gradle-managed emulator: `./gradlew :tv:generateBaselineProfile`
// The result lands in tv/src/release/generated/baselineProfiles/ and is merged
// into the release artifact alongside the library profiles at build time.
import com.android.build.api.dsl.ManagedVirtualDevice

plugins {
    // No version: AGP is already on the build classpath via :tv's android-application
    // alias, and re-declaring a version here trips Gradle's compatibility check.
    id("com.android.test")
    alias(libs.plugins.baselineprofile)
}

android {
    namespace = "com.hexstacker.baselineprofile"
    compileSdk = 37

    defaultConfig {
        minSdk = 28
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    targetProjectPath = ":tv"

    // A phone AVD, not a TV one: GMD's device catalog has no TV profiles, and the
    // profile is about which CODE runs (Compose lobby, entrance animation, QR
    // render), which is resolution/form-factor independent. The generator launches
    // MainActivity by explicit component since the app only registers a
    // LEANBACK_LAUNCHER. google_apis matches the system image already installed on
    // dev machines (aosp would download a second ~1.5GB image for nothing).
    testOptions.managedDevices.allDevices {
        create<ManagedVirtualDevice>("pixel6Api34") {
            device = "Pixel 6"
            apiLevel = 34
            systemImageSource = "google"
        }
    }
}

kotlin {
    jvmToolchain(17)
}

baselineProfile {
    managedDevices += "pixel6Api34"
    useConnectedDevices = false
}

dependencies {
    implementation(libs.androidx.test.ext.junit)
    implementation(libs.androidx.uiautomator)
    implementation(libs.androidx.benchmark.macro.junit4)
}
