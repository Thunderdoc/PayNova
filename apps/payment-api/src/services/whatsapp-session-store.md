# WhatsApp Session Persistence — Setup (Cloudflare Workers KV)

Keeps the paired WhatsApp (BerryProtocol) session alive across Render
free-tier deploys, which wipe the container filesystem. The payment-api
snapshots `data/berry_auth/`, `data/berry_store.db` (+ `-wal`/`-shm`) and
`data/whatsapp_session.json` into ONE Cloudflare Workers KV value, and
restores them on boot before the Berry singleton is created. The service
already auto-resumes from disk, so restored files reconnect with no QR scan.

## One-time Cloudflare setup (free tier, no payment info)

1. Cloudflare dashboard → Workers & Pages → KV → Create namespace
   (any name, e.g. `paynova-whatsapp-session`). Copy its **Namespace ID**.
2. My Profile → API Tokens → Create Token → use the "Edit Cloudflare
   Workers" template, or a custom token with exactly:
   **Account → Workers KV Storage → Edit**, scoped to your account.
   Copy the token once — it is shown only at creation.
3. Copy your **Account ID** from the dashboard URL / sidebar.

## Render env vars (payment-api service)

```
WP_SESSION_STORE_ENABLED=1
WP_SESSION_KV_ACCOUNT_ID=<your account id>
WP_SESSION_KV_NAMESPACE_ID=<your namespace id>
WP_SESSION_KV_API_TOKEN=<your token>
# Optional: WP_SESSION_KV_KEY (default: paynova-whatsapp-session-v1)
```

Then redeploy, pair WhatsApp once via Merchant Admin, and the session is
stored in KV. On the next deploy it restores automatically.

## Behaviour notes

- No env vars → module is a complete no-op; current behaviour unchanged.
- Saves happen on `connection.open`, on auth-file changes (2s debounce),
  and best-effort on SIGTERM. A failed save only logs a warning.
- Manual logout deletes the KV copy, so a logged-out session can never
  resurrect after a deploy. Transient disconnects keep the copy.
- The KV value holds live WhatsApp credentials: never share the API token,
  never paste the KV value anywhere, and scope the token to KV Edit only.
- Restores never overwrite existing local credential files — local files
  always win; KV only fills gaps (the deploy-wipe case).
