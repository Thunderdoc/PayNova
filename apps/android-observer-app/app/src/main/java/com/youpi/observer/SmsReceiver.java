package com.youpi.observer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import android.util.Log;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class SmsReceiver extends BroadcastReceiver {
    private static final String TAG = "YoupiSmsReceiver";
    private static final Pattern AMOUNT_PATTERN = Pattern.compile("(?:rs\\.?|inr|₹)\\s*([0-9,]+(?:\\.[0-9]{1,2})?)", Pattern.CASE_INSENSITIVE);
    private static final Pattern REF_PATTERN = Pattern.compile("(?:utr|ref(?:erence)?|txn(?:\\s*id)?|rrn)[:\\s#-]*([a-zA-Z0-9_-]{6,35})", Pattern.CASE_INSENSITIVE);
    private static final Pattern VPA_PATTERN = Pattern.compile("(?:from|by)\\s+([a-zA-Z0-9._-]{2,100}@[a-zA-Z0-9._-]{2,64})", Pattern.CASE_INSENSITIVE);

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) {
            return;
        }

        SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (messages == null || messages.length == 0) return;

        final ApiClient client = new ApiClient(context);
        if (!client.isPaired()) {
            Log.w(TAG, "SMS received but device is not paired with PayNova. Skipping.");
            return;
        }

        for (SmsMessage sms : messages) {
            if (sms == null) continue;
            final String sender = sms.getOriginatingAddress();
            final String body = sms.getMessageBody();
            final long timestamp = sms.getTimestampMillis();

            String text = body == null ? "" : body;
            String lower = text.toLowerCase(Locale.ROOT);
            if (!(lower.contains("credited") || lower.contains("received") || lower.contains("deposit") || lower.contains("payment received") || lower.contains("upi/cr"))) continue;
            Matcher amountMatcher = AMOUNT_PATTERN.matcher(text);
            if (!amountMatcher.find()) continue;
            final long amountPaise;
            try {
                amountPaise = Math.round(Double.parseDouble(amountMatcher.group(1).replace(",", "")) * 100.0d);
            } catch (Exception ignored) { continue; }
            if (amountPaise <= 0) continue;
            Matcher refMatcher = REF_PATTERN.matcher(text);
            final String bankRef = refMatcher.find() ? refMatcher.group(1) : null;
            Matcher vpaMatcher = VPA_PATTERN.matcher(text);
            final String senderVpa = vpaMatcher.find() ? vpaMatcher.group(1) : null;

            Log.i(TAG, "Captured structured bank credit from [" + sender + "]: ₹" + (amountPaise / 100.0d));

            // Dispatch the structured observation to PayNova in an asynchronous worker thread
            new Thread(new Runnable() {
                @Override
                public void run() {
                    boolean success = client.sendObservation(amountPaise, amountPaise / 100.0d, bankRef, senderVpa, sender, "Bank SMS credit");
                    Log.i(TAG, "Dispatched payment observation to PayNova: " + (success ? "SUCCESS" : "FAILED"));
                }
            }).start();
        }
    }
}
