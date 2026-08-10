import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm")
}

// Emit Java 17 bytecode — the level the Android module consumes — using
// whatever JDK is running the build, rather than pinning a toolchain. A
// toolchain would make this module unbuildable on a machine that has a
// perfectly capable newer JDK but not that exact one.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    // `org.json` is part of the Android platform, so the app ships no copy of
    // it; this artifact provides the same API for JVM unit tests, letting both
    // run the very same dispatcher code.
    compileOnly("org.json:json:20240303")
    testImplementation("org.json:json:20240303")
    testImplementation(kotlin("test"))
}

/**
 * The golden fixtures are owned by the JavaScript package that defines the
 * protocol. This module reads that file rather than keeping a copy — a copy is
 * precisely the thing that drifts, and the point of the fixtures is that both
 * halves are pinned to one artifact.
 */
val fixturesFile =
    rootProject.layout.projectDirectory
        .file("../packages/exo-android-admin/protocol/fixtures.json")
        .asFile

tasks.test {
    useJUnitPlatform()
    systemProperty("endo.fixtures", fixturesFile.absolutePath)
    // Re-run when the contract changes, even though it lives outside this
    // module's source set.
    inputs.file(fixturesFile).withPropertyName("protocolFixtures")
    testLogging {
        events("passed", "failed", "skipped")
    }
}
