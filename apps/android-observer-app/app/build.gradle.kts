plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.youpi.observer"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.youpi.observer"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "1.1.0"
    }

    // Release signing is opt-in: set PAYNOVA_KEYSTORE (+ passwords/alias) in the
    // environment when building a shippable APK. Without it, release stays
    // unsigned (installable only after signing) and debug builds are unaffected.
    // No key material ever lives in this repo.
    val paynovaKeystore = System.getenv("PAYNOVA_KEYSTORE")
    if (paynovaKeystore != null) {
        signingConfigs {
            create("release") {
                storeFile = file(paynovaKeystore)
                storePassword = System.getenv("PAYNOVA_STORE_PASSWORD")
                keyAlias = System.getenv("PAYNOVA_KEY_ALIAS")
                keyPassword = System.getenv("PAYNOVA_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        debug {
            // Keep local phone testing installable alongside the production package.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (paynovaKeystore != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // The repository previously contained parallel Java and Kotlin copies of the
    // same Android classes. Compile the maintained Kotlin implementations and
    // retain only the Java QR scanner, avoiding duplicate-class APK failures.
    sourceSets["main"].java.exclude(
        "**/ApiClient.java",
        "**/BootReceiver.java",
        "**/ForegroundService.java",
        "**/MainActivity.java",
        "**/PaymentNotificationListenerService.java",
        "**/SmsReceiver.java"
    )
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.zxing:core:3.5.3")
}
