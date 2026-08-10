plugins {
    id("com.android.application") version "8.7.3"
    kotlin("android") version "2.0.21"
}

android {
    namespace = "com.endojs.androidadmin"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.endojs.androidadmin"
        // API 26 is the floor for the foreground-service model this app
        // depends on; the Galaxy A37 target is far above it.
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        ndk {
            // The embedded Node runtime and the iroh NAPI binding are both
            // arm64 (see the design's "iroh on device"); shipping other ABIs
            // would bloat the APK with slices that have no matching binary.
            abiFilters += "arm64-v8a"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        jniLibs {
            // The nodejs-mobile runtime dlopen()s its own libraries.
            useLegacyPackaging = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}

dependencies {
    implementation(project(":protocol"))
    // `org.json` ships with the platform, so :protocol's compileOnly
    // dependency needs no runtime counterpart here.

    // The embedded Node runtime is added here once a nodejs-mobile
    // distribution is chosen; see android/README.md § "Remaining work".
}
