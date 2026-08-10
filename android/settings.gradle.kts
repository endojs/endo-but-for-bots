// The Endo Android device-owner agent.
//
// Two modules, split along the one seam that matters for testing:
//
//   :protocol — pure-JVM Kotlin. The bridge protocol and its dispatcher, with
//               no Android dependencies, so it compiles and runs its
//               fixture-driven tests on any JDK — no SDK, no emulator, no
//               device.
//   :app      — the Android device-owner application. Implements the
//               protocol's AdminOperations with DevicePolicyManager, embeds
//               the Endo daemon, and hosts the channel. Needs the Android SDK.
//
// `gradle :protocol:test` is therefore runnable in ordinary CI; the :app
// module is only included when an Android SDK is present, so the absence of
// one does not break the part that can be verified anywhere.

pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "endo-android-admin"

include(":protocol")

val androidSdkPresent =
    providers.environmentVariable("ANDROID_HOME").isPresent ||
        providers.environmentVariable("ANDROID_SDK_ROOT").isPresent ||
        file("local.properties").exists()

if (androidSdkPresent) {
    include(":app")
} else {
    logger.lifecycle(
        "No Android SDK detected (ANDROID_HOME / ANDROID_SDK_ROOT / local.properties); " +
            "skipping :app. The :protocol module and its fixture tests still build.",
    )
}
