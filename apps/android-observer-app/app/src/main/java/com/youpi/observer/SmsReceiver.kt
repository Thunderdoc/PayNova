package com.youpi.observer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log

/**
 * BroadcastReceiver listening for incoming SMS on the Android device.
 * Automatically extracts the bank SMS body, sender, and timestamp,
 * and securely forwards it to the paired Hackastra Pay Gateway.
 */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Telephony.Sms.Intents.SMS_RECEIVED_ACTION) {
            val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
            if (messages.isNullOrEmpty()) return

            val apiClient = ApiClient(context)
            if (!apiClient.isPaired()) {
                Log.w("SmsReceiver", "App not paired with merchant panel. Ignoring SMS.")
                return
            }

            for (sms in messages) {
                val sender = sms.originatingAddress ?: "UNKNOWN"
                val body = sms.messageBody ?: ""
                val timestamp = sms.timestampMillis

                val parsed = NotificationParser.parse(
                    packageName = "android.sms",
                    title = sender,
                    text = body,
                    postTime = timestamp
                ) ?: continue

                Log.d("SmsReceiver", "Captured structured bank credit from $sender: ₹${parsed.amountRupees}")

                Thread {
                    val success = apiClient.sendObservation(parsed)
                    Log.d("SmsReceiver", "Dispatched payment observation to Hackastra Pay: success=$success")
                }.start()
            }
        }
    }
}
