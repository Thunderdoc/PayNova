package com.youpi.observer

import android.content.Intent
import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.ImageView
import android.widget.ScrollView
import android.view.Gravity
import android.widget.Toast
import android.graphics.drawable.GradientDrawable
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationManagerCompat

class MainActivity : AppCompatActivity() {
    private lateinit var apiClient: ApiClient
    private lateinit var heartbeatScheduler: HeartbeatScheduler

    private lateinit var tvStatus: TextView
    private lateinit var tvDeviceId: TextView
    private lateinit var etBaseUrl: EditText
    private lateinit var etToken: EditText
    private lateinit var btnPair: Button
    private lateinit var btnPermission: Button
    private lateinit var pairingTitle: TextView
    private lateinit var qrScannerLauncher: ActivityResultLauncher<Intent>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        apiClient = ApiClient(this)
        heartbeatScheduler = HeartbeatScheduler(this)
        qrScannerLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            handleQrResult(result.resultCode, result.data)
        }

        // Premium, responsive programmatic layout. The pairing/authentication logic remains unchanged.
        // Background: deep navy gradient (top) melting into midnight blue (bottom).
        val layout = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(28, 40, 28, 32)
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(
                    android.graphics.Color.parseColor("#0A1730"),
                    android.graphics.Color.parseColor("#071126"),
                    android.graphics.Color.parseColor("#050A18")
                )
            )
        }

        val header = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 0, 0, 24)
        }
        // Logo in a rounded, softly glowing tile.
        val logo = ImageView(this).apply {
            setImageResource(com.youpi.observer.R.drawable.ic_hackastra_observer)
            scaleType = ImageView.ScaleType.CENTER_INSIDE
            background = GradientDrawable().apply {
                setColor(android.graphics.Color.parseColor("#102A50"))
                setStroke(2, android.graphics.Color.parseColor("#2C5BA8"))
                cornerRadius = 22f
            }
            elevation = 6f
        }
        logo.setPadding(10, 10, 10, 10)
        header.addView(logo, android.widget.LinearLayout.LayoutParams(80, 80))
        val heading = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(16, 0, 8, 0)
        }
        heading.addView(TextView(this).apply {
            text = "PayNova"
            textSize = 27f
            setTextColor(android.graphics.Color.WHITE)
            setTypeface(null, android.graphics.Typeface.BOLD)
        })
        heading.addView(TextView(this).apply {
            text = "O B S E R V E R"
            textSize = 11f
            setTextColor(android.graphics.Color.parseColor("#5EA0FF"))
            setTypeface(null, android.graphics.Typeface.BOLD)
            setPadding(0, 2, 0, 0)
        })
        heading.addView(TextView(this).apply {
            text = "Secure device connection"
            textSize = 13f
            setTextColor(android.graphics.Color.parseColor("#AFC6EA"))
            setPadding(0, 4, 0, 0)
        })
        header.addView(heading, android.widget.LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(Button(this).apply {
            text = "HELP"
            textSize = 12f
            setTextColor(android.graphics.Color.WHITE)
            background = roundedPill("#102A50")
            elevation = 4f
            setOnClickListener { Toast.makeText(this@MainActivity, "Use the dashboard QR or enter the gateway details below.", Toast.LENGTH_LONG).show() }
        }, android.widget.LinearLayout.LayoutParams(92, 48))
        layout.addView(header)

        tvStatus = TextView(this).apply {
            text = "NOTIFICATION ACCESS\nChecking permission status..."
            textSize = 17f
            setTextColor(android.graphics.Color.parseColor("#D4E4FF"))
            setPadding(28, 26, 28, 26)
            background = roundedCard("#0B2740", "#087F88")
            elevation = 8f
        }
        tvStatus.textSize = 15f
        tvStatus.minHeight = 100
        layout.addView(tvStatus, android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
            android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = 16 })

        tvDeviceId = TextView(this).apply {
            text = "DEVICE\nAndroid • ${android.os.Build.MODEL}"
            textSize = 16f
            setTextColor(android.graphics.Color.parseColor("#D4E4FF"))
            setPadding(28, 24, 28, 24)
            background = roundedCard("#0B1D3B", "#173F76")
            elevation = 8f
        }
        tvDeviceId.textSize = 14f
        tvDeviceId.minHeight = 78
        layout.addView(tvDeviceId, android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
            android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = 20 })

        btnPermission = Button(this).apply {
            text = "Grant Notification Listener Access"
            setTextColor(android.graphics.Color.WHITE)
            background = roundedPill("#16325F")
            minHeight = 64
            isAllCaps = false
            elevation = 6f
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }
        }
        layout.addView(btnPermission, android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
            android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = 24 })

        pairingTitle = TextView(this).apply {
            text = "PAIR WITH QR CODE\nScan the pairing QR from the PayNova dashboard to connect this device."
            textSize = 15f
            setTextColor(android.graphics.Color.parseColor("#D4E4FF"))
            setPadding(28, 26, 28, 14)
            background = roundedCard("#0B1D3B", "#173F76")
            elevation = 8f
        }
        layout.addView(pairingTitle, android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
            android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = 16 })

        val btnScanQr = Button(this).apply {
            text = "▣  SCAN PAIRING QR"
            textSize = 14f
            setTextColor(android.graphics.Color.WHITE)
            background = roundedPill("#0866FF")
            minHeight = 64
            isAllCaps = false
            elevation = 8f
            setOnClickListener {
                if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(arrayOf(Manifest.permission.CAMERA), 4101)
                } else {
                    qrScannerLauncher.launch(Intent(this@MainActivity, QrScannerActivity::class.java))
                }
            }
        }
        layout.addView(btnScanQr, android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
            android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = 20 })

        val manualTitle = TextView(this).apply {
            text = "MANUAL CONNECTION\nUse this only if QR scanning is unavailable."
            textSize = 14f
            setTextColor(android.graphics.Color.parseColor("#9FB5D8"))
            setPadding(0, 24, 0, 10)
        }
        layout.addView(manualTitle)

        etBaseUrl = EditText(this).apply {
            hint = "Gateway URL (e.g. http://192.168.1.100:6100)"
            setText(apiClient.getBaseUrl())
            textSize = 15f
            setTextColor(android.graphics.Color.WHITE)
            setHintTextColor(android.graphics.Color.parseColor("#7186A8"))
            background = roundedInput()
            setPadding(18, 12, 18, 12)
            minHeight = 58
        }
        layout.addView(etBaseUrl, android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
            android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = 12 })

        etToken = EditText(this).apply {
            hint = "Enrollment Token"
            textSize = 15f
            setTextColor(android.graphics.Color.WHITE)
            setHintTextColor(android.graphics.Color.parseColor("#7186A8"))
            background = roundedInput()
            setPadding(18, 12, 18, 12)
            minHeight = 58
        }
        layout.addView(etToken, android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
            android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = 20 })

        btnPair = Button(this).apply {
            text = "Pair with Merchant Gateway"
            setTextColor(android.graphics.Color.WHITE)
            background = roundedPill("#0B8F78")
            minHeight = 64
            isAllCaps = false
            elevation = 8f
            setOnClickListener {
                performPairing()
            }
        }
        layout.addView(btnPair)

        // Footer: quiet brand line, no claims beyond what the app does.
        layout.addView(TextView(this).apply {
            text = "PayNova Observer • v1.1.0\nKeep notification access on — payments are observed only on this device."
            textSize = 12f
            gravity = Gravity.CENTER
            setTextColor(android.graphics.Color.parseColor("#7186A8"))
            setPadding(0, 28, 0, 8)
        })

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(android.graphics.Color.parseColor("#050A18"))
            addView(layout)
        }
        setContentView(scroll)
        updateStatus()
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
    }

    private fun handleQrResult(resultCode: Int, data: Intent?) {
        if (resultCode != RESULT_OK || data == null) return

        try {
            val payload = data.getStringExtra(QrScannerActivity.EXTRA_QR_PAYLOAD)?.trim().orEmpty()
            val json = org.json.JSONObject(payload)
            if (json.optString("type") != "YOUPI_SMS_GATEWAY_PAIR") {
                Toast.makeText(this, "Invalid PayNova pairing QR", Toast.LENGTH_LONG).show()
                return
            }
            val serverUrl = json.optString("serverUrl", json.optString("gatewayUrl", json.optString("apiBaseUrl", "")))
            val token = json.optString("enrollmentToken", json.optString("token", ""))
            if ((!serverUrl.startsWith("http://") && !serverUrl.startsWith("https://")) || token.isEmpty()) {
                Toast.makeText(this, "Invalid PayNova pairing QR", Toast.LENGTH_LONG).show()
                return
            }
            etBaseUrl.setText(serverUrl)
            etToken.setText(token)
            Toast.makeText(this, "Pairing with merchant gateway…", Toast.LENGTH_SHORT).show()
            Thread {
                val success = apiClient.pair(serverUrl, token, android.os.Build.MODEL)
                runOnUiThread {
                    Toast.makeText(this, if (success) "Device paired successfully" else "Pairing failed: check network", Toast.LENGTH_LONG).show()
                    updateStatus()
                }
            }.start()
        } catch (_: Exception) {
            Toast.makeText(this, "Invalid PayNova pairing QR", Toast.LENGTH_LONG).show()
        }
    }

    private fun updateStatus() {
        val hasPermission = NotificationManagerCompat.getEnabledListenerPackages(this).contains(packageName)
        btnPermission.isEnabled = !hasPermission
        btnPermission.text = if (hasPermission) "✓ Notification Access Granted" else "Grant Notification Listener Access"

        tvStatus.text = if (hasPermission) {
            "NOTIFICATION ACCESS\nGranted successfully\nPayment notifications can be observed from this device."
        } else {
            "NOTIFICATION ACCESS\nPermission required\nGrant access to observe payment notifications."
        }
        tvStatus.setTextColor(if (hasPermission) android.graphics.Color.parseColor("#35F19A") else android.graphics.Color.parseColor("#FCA5A5"))

        if (apiClient.isPaired()) {
            tvStatus.text = "✓  GATEWAY CONNECTED\nDevice paired successfully\nPayment notifications are ready to be observed."
            tvStatus.setTextColor(android.graphics.Color.parseColor("#35F19A"))
            tvDeviceId.text = "DEVICE\nAndroid • ${android.os.Build.MODEL}\nGateway: CONNECTED • READY"
            pairingTitle.text = "PAIRING COMPLETE\nThis device is connected. Keep notification access enabled to observe payment updates."
            btnPair.text = "✓  DEVICE PAIRED — OBSERVER READY"
            btnPair.isEnabled = false
            heartbeatScheduler.start()
        } else {
            tvDeviceId.text = "DEVICE\nAndroid • ${android.os.Build.MODEL}\nGateway: NOT PAIRED"
            pairingTitle.text = "PAIR WITH QR CODE\nScan the pairing QR from the PayNova dashboard to connect this device."
            btnPair.text = "PAIR WITH MERCHANT GATEWAY"
            btnPair.isEnabled = true
            heartbeatScheduler.stop()
        }
    }

    private fun roundedButton(color: String) = GradientDrawable().apply {
        setColor(android.graphics.Color.parseColor(color))
        cornerRadius = 18f
    }

    // Fully rounded pill for primary actions (64px tall buttons).
    private fun roundedPill(color: String) = GradientDrawable().apply {
        setColor(android.graphics.Color.parseColor(color))
        cornerRadius = 32f
    }

    private fun roundedInput() = GradientDrawable().apply {
        setColor(android.graphics.Color.parseColor("#13213A"))
        setStroke(1, android.graphics.Color.parseColor("#2C4670"))
        cornerRadius = 18f
    }

    private fun roundedCard(fill: String, stroke: String) = GradientDrawable().apply {
        setColor(android.graphics.Color.parseColor(fill))
        setStroke(2, android.graphics.Color.parseColor(stroke))
        cornerRadius = 28f
    }

    private fun performPairing() {
        val url = etBaseUrl.text.toString().trim()
        val token = etToken.text.toString().trim()

        if (url.isEmpty() || token.isEmpty()) {
            Toast.makeText(this, "Please enter Gateway URL and Token", Toast.LENGTH_SHORT).show()
            return
        }
        val host = try { java.net.URI(url).host.orEmpty().lowercase() } catch (_: Exception) { "" }
        if (host == "localhost" || host == "127.0.0.1" || host == "0.0.0.0") {
            Toast.makeText(this, "Use your computer's LAN IP, not localhost (example: http://192.168.1.10:6100)", Toast.LENGTH_LONG).show()
            return
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            Toast.makeText(this, "Gateway URL must start with http:// or https://", Toast.LENGTH_LONG).show()
            return
        }

        Thread {
            val success = apiClient.pair(url, token, android.os.Build.MODEL)
            runOnUiThread {
                if (success) {
                    Toast.makeText(this, "Device Paired Successfully!", Toast.LENGTH_LONG).show()
                    updateStatus()
                } else {
                    Toast.makeText(this, "Pairing Failed. Check URL and Token.", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }
}
