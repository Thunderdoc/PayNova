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
        versionCode = 1
        versionName = "1.0.0"
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
