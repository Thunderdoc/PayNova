package com.youpi.observer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * BroadcastReceiver that triggers upon device boot (RECEIVE_BOOT_COMPLETED).
 * Automatically restarts the PayNova observer service and heartbeat scheduler.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action == Intent.ACTION_BOOT_COMPLETED || intent?.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            Log.i("PayNovaBootReceiver", "Device boot detected. Restarting PayNova Payment Observer...")
            context?.let { ctx ->
                val apiClient = ApiClient(ctx)
                if (apiClient.isPaired()) {
                    val scheduler = HeartbeatScheduler(ctx)
                    scheduler.start()
                    Log.i("PayNovaBootReceiver", "PayNova Payment Observer successfully re-armed on boot.")
                }
            }
        }
    }
}
