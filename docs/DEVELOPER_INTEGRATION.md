# PayNova — Developer Integration Guide

Welcome to the official developer integration guide for **PayNova**.

PayNova provides a **Universal One-Script Integration** that allows any web application to accept UPI payments with zero aggregator fees, sub-second QR rendering, and automated SMS/Gmail observation verification.

---

## 1. Quick Start (5-Minute Integration)

### Step 1: Add the Script
Include the official script in your HTML:

```html
<script 
  src="https://<checkout-portal-host>/youpi.js" 
  data-youpi-key="YOUR_MERCHANT_KEY">
</script>
```

*(For local testing, `<checkout-portal-host>` is `http://localhost:7000`)*

### Step 2: Add Your Payment Button
Add the `data-youpi-pay` attribute to your payment button:

```html
<button 
  data-youpi-pay 
  data-order-id="ORDER-1001" 
  data-amount="499">
  Pay ₹499
</button>
```

When clicked, the script automatically dims and blurs the page, pops up the centered 2-column modal (or fluid bottom sheet on mobile), and loads the checkout session.

---

## 2. Button Attributes Reference

| Attribute | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `data-youpi-pay` | **Yes** | Flags element as a YOUPI checkout trigger | *(boolean)* |
| `data-amount` | **Yes** | Amount in INR | `"499.00"` |
| `data-order-id` | Optional | Merchant order ID (auto-generated if omitted) | `"ORD-9988"` |
| `data-currency` | Optional | Currency (defaults to `INR`) | `"INR"` |
| `data-name` | Optional | Brand / Store display name | `"Acme Store"` |
| `data-description` | Optional | Order description in checkout | `"Digital Coins"` |
| `data-customer-name` | Optional | Customer full name | `"Mohit Kumar"` |
| `data-customer-email` | Optional | Customer email | `"mohit@example.com"` |
| `data-customer-phone` | Optional | Customer mobile number (WhatsApp auth) | `"9876543210"` |
| `data-metadata` | Optional | JSON string of custom developer metadata | `'{"plan":"pro"}'` |
| `data-success-url` | Optional | Redirect URL on payment success | `"/order-success"` |
| `data-failed-url` | Optional | Redirect URL on payment failure | `"/order-failed"` |
| `data-suspicious-url`| Optional | Redirect URL if flagged as suspicious | `"/order-suspicious"` |
| `data-expired-url` | Optional | Redirect URL on session expiry | `"/order-expired"` |
| `data-cancelled-url`| Optional | Redirect URL on user cancellation | `"/order-cancelled"` |

---

## 3. Programmatic Usage (`Youpi.pay`)

For Single Page Applications (React, Vue, Angular, Svelte, Next.js):

```javascript
Youpi.pay({
  order_id: "ORDER-1001",
  amount: 499.00,
  currency: "INR",
  customer: {
    name: "Mohit Kumar",
    email: "mohit@example.com",
    phone: "9876543210"
  },
  metadata: {
    sku: "SUBSCRIPTION-YEARLY",
    user_id: "usr_42"
  },
  handler: function(response) {
    console.log("Payment Confirmed:", response);
    // { status: "SUCCESS", order_id: "ORDER-1001", amount_received: 499.00, utr: "123456789012", payment_mode: "UPI" }
  },
  onFailed: function(response) {
    console.warn("Payment Failed:", response.reason);
  },
  onClose: function() {
    console.log("Customer closed the checkout modal");
  }
});
```

---

## 4. Frontend Browser Payment Events

The script emits standard DOM `CustomEvent`s on `window`:

```javascript
// 1. Success Event
window.addEventListener('youpi:payment:success', (e) => {
  const { order_id, amount_received, utr, payment_mode } = e.detail;
  console.log(`Order ${order_id} verified! Bank UTR: ${utr}`);
});

// 2. Failed Event
window.addEventListener('youpi:payment:failed', (e) => {
  console.log(`Order ${e.detail.order_id} failed: ${e.detail.reason}`);
});

// 3. Suspicious / Security Review Event
window.addEventListener('youpi:payment:suspicious', (e) => {
  console.warn(`Order ${e.detail.order_id} held for security review.`);
});

// 4. Session Expired Event
window.addEventListener('youpi:payment:expired', (e) => {
  console.log(`Order ${e.detail.order_id} active window expired.`);
});

// 5. Cancelled Event
window.addEventListener('youpi:payment:cancelled', (e) => {
  console.log(`Order ${e.detail.order_id} cancelled by customer.`);
});
```

> **SECURITY NOTICE**: Browser events are designed strictly to update frontend user interfaces. Never mark an order fulfilled solely based on client-side events.

---

## 5. Authoritative Backend Webhooks

The only authoritative confirmation of payment is the **HMAC-SHA256 signed server-to-server webhook**.

### Webhook Delivery Format:
- **Headers**:
  - `Content-Type: application/json`
  - `X-Gateway-Event: SUCCESS`
  - `X-Gateway-Signature: sha256=<hex_hmac_sha256>`
  - `X-Gateway-Delivery-Id: <uuid>`
  - `X-Gateway-Timestamp: <timestamp_ms>`
- **Payload**:
  ```json
  {
    "event": "SUCCESS",
    "paymentId": "c7942127-14e3-469a-9e4a-9359a16f903a",
    "orderId": "ORDER-1001",
    "amount": "499.00",
    "amountPaise": 49900,
    "currency": "INR",
    "method": "UPI",
    "utr": "123456789012",
    "completedAt": "2026-10-07T12:00:00.000Z",
    "metadata": { "sku": "SUBSCRIPTION-YEARLY" }
  }
  ```

### Verification Security Invariants:
- **Raw Body Required**: Consumers **MUST** compute the HMAC over raw, unparsed request bytes. Never parse JSON before HMAC calculation.
- **Constant-Time Comparison**: Protect against timing side-channel attacks by always using constant-time comparison functions:
  - Node.js: `crypto.timingSafeEqual`
  - Python: `hmac.compare_digest`
  - PHP: `hash_equals`
  - Go: `hmac.Equal`
- **Signature Prefix**: Formatted as `X-Gateway-Signature: sha256=<64_char_hex_hash>`.

### Verification Implementations:

#### 1. Node.js (Express)
```javascript
import crypto from 'node:crypto';

app.post('/api/youpi-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-gateway-signature'] || '';
  const secret = process.env.YOUPI_WEBHOOK_SECRET;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');

  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const payload = JSON.parse(req.body.toString('utf8'));
  if (payload.event === 'SUCCESS') {
    // Fulfill order: payload.orderId, payload.utr, payload.amount, payload.amountPaise
  }
  res.status(200).json({ received: true });
});
```

#### 2. Python (FastAPI)
```python
import hmac, hashlib, json
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()

@app.post("/api/youpi-webhook")
async def youpi_webhook(request: Request):
    raw_body = await request.body()
    signature = request.headers.get("X-Gateway-Signature", "")
    secret = request.app.state.webhook_secret.encode("utf-8")

    expected = "sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    payload = json.loads(raw_body.decode("utf-8"))
    if payload.get("event") == "SUCCESS":
        # Fulfill order: payload["orderId"], payload["utr"], payload["amount"]
        pass
    return {"received": True}
```

#### 3. PHP
```php
<?php
$rawPayload = file_get_contents('php://input');
$signature = $_SERVER['HTTP_X_GATEWAY_SIGNATURE'] ?? '';
$secret = getenv('YOUPI_WEBHOOK_SECRET');

$expected = 'sha256=' . hash_hmac('sha256', $rawPayload, $secret);

if (!hash_equals($expected, $signature)) {
    http_response_code(401);
    exit(json_encode(['error' => 'Invalid webhook signature']));
}

$payload = json_decode($rawPayload, true);
if (($payload['event'] ?? '') === 'SUCCESS') {
    // Fulfill order: $payload['orderId'], $payload['utr'], $payload['amount']
}

http_response_code(200);
echo json_encode(['received' => true]);
?>
```

#### 4. Go (`net/http`)
```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
)

func youpiWebhookHandler(w http.ResponseWriter, r *http.Request) {
	rawBody, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Cannot read body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	signature := r.Header.Get("X-Gateway-Signature")
	secret := []byte(os.Getenv("YOUPI_WEBHOOK_SECRET"))

	mac := hmac.New(sha256.New, secret)
	mac.Write(rawBody)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(signature), []byte(expected)) {
		http.Error(w, "Invalid webhook signature", http.StatusUnauthorized)
		return
	}

	var payload struct {
		Event       string `json:"event"`
		OrderId     string `json:"orderId"`
		UTR         string `json:"utr"`
		Amount      string `json:"amount"`
		AmountPaise int64  `json:"amountPaise"`
	}
	if err := json.Unmarshal(rawBody, &payload); err == nil && payload.Event == "SUCCESS" {
		// Fulfill order: payload.OrderId, payload.UTR, payload.Amount
	}

	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"received":true}`))
}
```
