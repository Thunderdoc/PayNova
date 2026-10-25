# PayNova production-readiness audit

Audited: 2026-10-19

## Current verified strengths

- Payment success is driven by the server-side verification pipeline rather than a browser "force success" endpoint.
- Checkout exposes UPI QR, UPI Link/Intent, Cash Counter, and COD; legacy card-counter support is not rendered to customers.
- QR generation rejects missing recipient/amount data instead of using a fake VPA or amount.
- WhatsApp receipts are generated as PDF documents and sent as documents.
- Printable QR standees use the selected receiving account and generate a real UPI QR.
- Android observations are HMAC-signed, timestamp checked, and attribution remains server-side.
- Android SMS receiver implementations filter locally and send structured credit observations instead of arbitrary SMS bodies.
- Android pairing now uses short-lived, single-use random tokens; the old reusable secret and hardcoded backdoor token were removed.
- Android observer integration tests pass 5/5; the Node regression suite has passed 32/32 in the latest completed runs.
- Current machine inspection confirms no `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `JAVA_HOME`, Gradle, `adb`, or `sdkmanager` is available.
- `npm run typecheck` passes after restoring missing workspace project configurations.
- Checkout QR unavailable responses are bounded and return an explicit 409 instead of hanging.
- Receipt generation tests pass 4/4, including PDF metadata, attachment encoding, and notification idempotency.
- Android release build now succeeds with the local Gradle/SDK toolchain; the APK is signed with a development keystore and verified with APK Signature Scheme v2/v3.

## Blocking findings before production

### P0 — Admin API still needs a real operator login/session

The Payment API now has a production fail-closed `ADMIN_API_KEY` gate for `/api/v1/admin/*`, with constant-time comparison. The merchant-admin server forwards that key server-to-server and never renders it into browser HTML. Local test mode intentionally bypasses the gate.

Remaining gap: the dashboard has no operator login/session, MFA, role separation, or CSRF protection. A production deployment must configure the key and place the dashboard behind an authenticated operator session or OIDC layer.

Required fix: add an authenticated admin session or OIDC login, enforce RBAC on every `/api/v1/admin/*` route, add CSRF protection for cookie sessions, and retain the fail-closed API gate. Do not rely on `x-merchant-id` as authorization.

### P0 — Pairing QR endpoint authorization is implemented; operator identity remains

`/api/v1/admin/sms-gateway/pair-qr` is covered by the shared `/api/v1/admin/*` authorization middleware and pairing tokens are short-lived and single-use. The remaining production gap is the operator identity layer: the current API-key gate must be fronted by an authenticated admin session or OIDC/RBAC principal before production deployment.

### P0 — Production transport must be HTTPS-only

The development stack intentionally uses localhost HTTP, but production configuration must reject cleartext origins, require TLS at the proxy, set secure cookies, and use an allowlist for CORS. Never expose the payment API or observer endpoints directly to the public internet.

### P1 — Android APK production signing and release reproducibility

The Android module now builds successfully using the locally provisioned SDK/Gradle toolchain. The delivered test APK is signed with a development keystore and has verified v2/v3 signatures. Before production distribution, replace it with an organization-controlled release keystore, protect the signing credentials, add a Gradle wrapper/CI build, and publish the checksum.

### P1 — TypeScript project references were incomplete (fixed)

All referenced workspace projects now have consistent `tsconfig.json` files, and `npm run typecheck` passes. CI should still run this gate on every release.

### P1 — Secrets and pairing configuration need fail-closed defaults

Development fallback secrets and localhost defaults remain throughout the repository. Production startup must fail if webhook secrets, admin authentication, database encryption/backups, base URLs, and observer credentials are missing or weak.

### P1 — Observer privacy and retention policy is required

Document what payment fields are collected, encrypt them at rest, minimize raw payload retention, restrict administrator access, define deletion/retention windows, and provide a customer/merchant privacy notice. Bank SMS and email data are highly sensitive.

## High-value hardening work

1. Add idempotency keys and unique constraints for every payment creation, COD confirmation, counter confirmation, receipt send, and webhook delivery.
2. Add webhook replay protection using delivery ID, timestamp tolerance, constant-time signature verification, and a durable delivery ledger.
3. Add per-merchant authorization to every read/write query; never trust a merchant ID from a query parameter or header without an authenticated principal.
4. Add structured security logging for login, pairing, admin changes, observer enrollment, failed signatures, rate limits, and manual payment actions.
5. Add dependency scanning, secret scanning, SBOM generation, lockfile review, and signed release artifacts to CI.
6. Add integration tests for unauthorized admin access, cross-merchant access, replayed pairing tokens, replayed webhooks, duplicate payment creation, stale QR sessions, COD unpaid state, and receipt delivery failure.
7. Add operational monitoring: payment-state latency, observer heartbeat age, verification mismatch rate, WhatsApp/email delivery status, queue depth, database health, backup freshness, and alerting.
8. Replace broad CORS and public test/developer routes with explicit environment-gated access. Test-mode injection must be impossible in production, not merely hidden in the UI.
9. Add database migrations with backups, restore drills, transaction boundaries, and a documented rollback plan.
10. Complete browser QA at 360, 390, 768, 1024, and desktop widths, including keyboard navigation, screen-reader labels, reduced motion, offline/network failure, and all four payment-method states.

## Recommended additions

- Admin OIDC/passkey login with MFA and role separation (owner, operations, support, read-only auditor).
- Merchant API keys with scopes and rotation, separate from webhook secrets.
- Signed, versioned Android observer releases with in-app update and remote revoke/unpair.
- Notification Listener as the primary Android source, Gmail as a server-side fallback, and SMS only as an explicit opt-in fallback.
- A payment reconciliation screen showing expected amount, observed amount, UTR, account, timestamp, verification tier, and reason codes.
- A customer-visible status timeline: initiated, awaiting payment, detected, verifying, success, failed, expired, cancelled.
- A downloadable privacy policy, data-processing notice, support escalation path, and incident-response runbook.

## Release gate

Do not advertise this as production-ready until all P0 items are closed, the Android release APK is built and signed, typecheck/CI is green, an unauthorized-access test suite passes, and a restore-from-backup drill is documented.
