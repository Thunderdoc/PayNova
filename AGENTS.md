# AGENTS.md — Integration Guide for AI Coding Agents

> **Audience**: AI Coding Agents & Pair Programmers integrating PayNova into developer applications.  
> **Purpose**: Authoritative reference on the PayNova payment lifecycle, one-script frontend integration, browser events, and server-to-server webhook verification.

---

## 1. High-Level Architecture

PayNova is a self-hosted, sovereign payment gateway designed for zero-fee UPI and counter payments with automated banking observation (SMS & Gmail parsing).

```
  [ Merchant Website / App ]
              │
    (1) Adds one script: <script src=".../youpi.js" data-youpi-key="...">
              │
    (2) Maps payment button: <button data-youpi-pay data-order-id="..." data-amount="...">
              │
    (3) PayNova JS dims/blurs background & renders centered responsive modal (or mobile sheet)
              │
    (4) Existing iframe loads /checkout/:id with dynamic single-use QR and UPI intent
              │
    (5) Customer pays via any UPI app (GPay, PhonePe, Paytm, CRED, BHIM)
              │
    (6) Banking Observers detect SMS / Gmail credit notification
              │
    (7) Verification Engine verifies amount, UTR, and timestamps
              │
    (8) Payment State Machine transitions session to SUCCESS
              │
     ┌────────┴──────────────────────────┐
     ▼                                   ▼
 [ Browser CustomEvents ]      [ Signed Webhook Delivery ]
 youpi:payment:success          POST /api/webhook (HMAC-SHA256)
 (For instant UI feedback)      (AUTHORITATIVE PROOF OF PAYMENT)
```

---

## 2. Universal One-Script Integration

### Step 1: Script Inclusion
Place the script tag in the page's HTML `<head>` or `<body>`:

```html
<script 
  src="https://<paynova-checkout-host>/paynova.js" 
  data-paynova-key="YOUR_MERCHANT_KEY">
</script>
```

- When running locally, `<paynova-checkout-host>` is `http://localhost:7000`.
- In production, it is your canonical checkout portal domain (e.g., `https://pay.yourdomain.com`).

### Step 2: One-Button Zero-JS Configuration
Tag any clickable button with `data-youpi-pay`:

```html
<button 
  data-paynova-pay 
  data-order-id="ORDER-1001" 
  data-amount="499"
  data-currency="INR"
  data-customer-name="Mohit"
  data-customer-email="mohit@example.com"
  data-customer-phone="9876543210"
  data-metadata='{"sku":"TSHIRT-01"}'>
  Buy Now
</button>
```

The script automatically binds click events to elements with `[data-paynova-pay]`, including elements created dynamically at runtime.

### Step 3: Programmatic API (`PayNova.pay`)
For single-page apps (React, Next.js, Vue, Nuxt, Svelte), use the programmatic interface:

```javascript
PayNova.pay({
  order_id: "ORDER-1001",
  amount: 499.00,
  currency: "INR",
  customer: {
    name: "Mohit",
    email: "mohit@example.com",
    phone: "9876543210"
  },
  metadata: {
    sku: "TSHIRT-01",
    cart_id: "CART-99"
  },
  handler: function(response) {
    console.log("Payment confirmed in modal:", response);
    // response: { status: "SUCCESS", order_id, amount_received, utr, payment_mode }
  },
  onClose: function() {
    console.log("Modal closed by customer");
  }
});
```

---

> Legacy aliases still work: `youpi.js`, `data-youpi-pay`, and `Youpi.pay` are kept for existing integrations.

## 3. Normalized Browser Events

The frontend script emits normalized DOM `CustomEvent`s on `window`:

| Event Name | Trigger Condition |
| :--- | :--- |
| `youpi:payment:success` | Payment verified by banking observers |
| `youpi:payment:failed` | Payment declined, wrong amount, or verification timeout |
| `youpi:payment:suspicious` | Payment flagged by security/risk engine |
| `youpi:payment:expired` | 5-minute active payment window expired |
| `youpi:payment:cancelled` | Customer cancelled or dismissed the checkout |
| `youpi:payment:result` | Unified event dispatched on any outcome |

### Payload Contract (`event.detail`):
```javascript
{
  "status": "SUCCESS",              // 'SUCCESS' | 'FAILED' | 'SUSPICIOUS' | 'EXPIRED' | 'CANCELLED'
  "order_id": "ORDER-1001",
  "amount_received": 499.00,
  "payment_mode": "UPI",            // 'UPI' | 'COD' | 'CASH_COUNTER' | 'CARD_COUNTER'
  "utr": "123456789012",            // 12-digit bank reference number
  "timestamp": "2026-10-07T12:00:00.000Z",
  "metadata": { "sku": "TSHIRT-01" }
}
```

---

## 4. Authoritative Server-to-Server Webhooks

> **CRITICAL RULE**: Browser events are strictly for user interface updates.  
> **NEVER** mark orders as fulfilled or deliver digital goods based on browser events. Only fulfill orders after verifying the server-to-server webhook!  
> **RAW BODY REQUIREMENT**: Request bytes must **NOT** be parsed to JSON before HMAC calculation. Parsing and re-stringifying alters whitespace and key order, causing signature verification failure. Always compute HMAC over raw unparsed request bytes!

### Webhook Request Specifications:
- **HTTP Method**: `POST`
- **Headers**:
  - `Content-Type: application/json`
  - `X-Gateway-Event: SUCCESS`
  - `X-Gateway-Signature: sha256=<64_char_hex_hash>`
  - `X-Gateway-Delivery-Id: <uuid>`
  - `X-Gateway-Timestamp: <ms>`

### Payload Contract (`payload`):
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
  "metadata": { "sku": "TSHIRT-01" }
}
```

### Polyglot Webhook Verification Implementations:

#### 1. Node.js (Express)
```javascript
import crypto from 'node:crypto';

app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-gateway-signature'] || '';
  const secret = process.env.YOUPI_WEBHOOK_SECRET;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');

  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const payload = JSON.parse(req.body.toString('utf8'));
  if (payload.event === 'SUCCESS') {
    // Authoritatively mark order as PAID in merchant database
    db.orders.markPaid(payload.orderId, {
      utr: payload.utr,
      amount: payload.amount,
      amountPaise: payload.amountPaise
    });
  }

  res.status(200).json({ received: true });
});
```

#### 2. Python (FastAPI)
```python
import hmac, hashlib, json
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()

@app.post("/api/webhook")
async def youpi_webhook(request: Request):
    raw_body = await request.body()
    signature = request.headers.get("X-Gateway-Signature", "")
    secret = request.app.state.webhook_secret.encode("utf-8")

    expected = "sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    payload = json.loads(raw_body.decode("utf-8"))
    if payload.get("event") == "SUCCESS":
        # Authoritatively mark order as PAID: payload["orderId"], payload["utr"], payload["amount"]
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
    // Authoritatively mark order as PAID: $payload['orderId'], $payload['utr'], $payload['amount']
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
		// Authoritatively mark order as PAID: payload.OrderId, payload.UTR, payload.Amount
	}

	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"received":true}`))
}
```

---

## 5. Security & Architectural Invariants

1. **No Public Force-Success Endpoint**:
   - There is no endpoint that allows a client or developer to arbitrarily declare `SUCCESS`.
   - `SUCCESS` is generated solely by the internal verification engine after matching a genuine bank SMS/Gmail observation.
2. **Never Expose Secret API Keys in Frontend**:
   - Only publishable public keys (e.g., `data-paynova-key`) may appear in HTML/JS.
   - `webhookSecret`, database credentials, and observer tokens must remain strictly on the backend.
3. **Idempotency & Deduplication**:
   - Webhook deliveries include unique `X-Gateway-Delivery-Id` and `orderId`. Merchants must ensure their webhook processing is idempotent.
4. **Preserve Customer Metadata**:
   - Unrecognized fields in `metadata` are passed through untouched and included in webhooks and API responses.

---

## 6. Service Ports (Local Development Reference)

| Service | Port | Description |
| :--- | :--- | :--- |
| **Coin Wallet Demo Store** | `5000` | Reference merchant implementation & store |
| **Payment Core REST API** | `6100` | Core gateway engine, state machine, queue |
| **Checkout Portal** | `7000` | Serves `paynova.js`, iframe `/checkout/:id`, API proxy |
| **Merchant Admin** | `6001` | Dashboard for slots, receiving VPAs, observers |
| **SMS Observer** | `6002` | Android SMS banking webhook ingester |
| **Gmail Observer** | `6003` | Push notification / Gmail observation ingester |
