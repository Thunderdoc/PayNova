import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YoupiPaymentClient } from '@youpi/merchant-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In production, reliably ensure environment variables from .env are loaded if not already provided
if (!process.env.BASE_PAYMENT_API_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}

export class CoinWalletStoreServer {
  /**
   * @param {{
   *   gatewayApiUrl?: string,
   *   merchantId?: string,
   *   webhookSecret?: string
   * }} [options={}]
   */
  constructor(options = {}) {
    const internalPort = process.env.PAYMENT_API_PORT || 6100;
    this.gatewayApiUrl = options.gatewayApiUrl || process.env.PAYMENT_API_INTERNAL_URL || `http://127.0.0.1:${internalPort}`;
    this.merchantId = options.merchantId || '00000000-0000-0000-0000-000000000001';
    // Rotation-safe: the DB seed already uses COIN_STORE_WEBHOOK_SECRET
    // (packages/db migrate), so the store must read the same env var —
    // otherwise the API signs with the rotated DB secret while the store
    // still verifies with the hardcoded default and every webhook fails.
    this.webhookSecret = options.webhookSecret || process.env.COIN_STORE_WEBHOOK_SECRET || 'merchant_webhook_secret_for_wallet_store';

    this.paymentClient = new YoupiPaymentClient({
      apiUrl: this.gatewayApiUrl,
      merchantId: this.merchantId,
      webhookSecret: this.webhookSecret
    });

    // In-memory persistent wallet balance & ledger for demo store
    this.walletCoins = 50; // default starting balance
    this.transactionHistory = [];

    this.storeHtml = fs.readFileSync(path.join(__dirname, 'store.html'), 'utf8');
    this.walletHtml = fs.readFileSync(path.join(__dirname, 'wallet.html'), 'utf8');
    this.orderSuccessHtml = fs.readFileSync(path.join(__dirname, 'order-success.html'), 'utf8');
    this.orderFailedHtml = fs.readFileSync(path.join(__dirname, 'order-failed.html'), 'utf8');
    this.orderSuspiciousHtml = fs.readFileSync(path.join(__dirname, 'order-suspicious.html'), 'utf8');
    this.orderExpiredHtml = fs.readFileSync(path.join(__dirname, 'order-expired.html'), 'utf8');
    this.orderCancelledHtml = fs.readFileSync(path.join(__dirname, 'order-cancelled.html'), 'utf8');
  }

  creditCoins(orderId, coins, packName) {
    this.walletCoins += Number(coins);
    this.transactionHistory.unshift({
      orderId,
      packName: packName || 'Coin Pack',
      coins: Number(coins),
      status: 'CREDITED',
      timestamp: new Date().toISOString()
    });
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method.toUpperCase();

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Gateway-Signature, X-Gateway-Event'
        });
        res.end();
        return;
      }

      // GET /assets/* (serve product screenshots and icons)
      if (pathname.startsWith('/assets/') && (method === 'GET' || method === 'HEAD')) {
        const assetName = path.basename(pathname);
        const assetPath = path.join(__dirname, '../public/assets', assetName);
        if (fs.existsSync(assetPath)) {
          const ext = path.extname(assetName).toLowerCase();
          const contentType = ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400'
          });
          if (method === 'HEAD') { res.end(); return; }
          const stream = fs.createReadStream(assetPath);
          stream.pipe(res);
          return;
        }
      }

      // GET /health
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'coin-wallet-store', coins: this.walletCoins }));
        return;
      }

      // GET /paynova.js or /youpi.js (Universal Frontend Integration Script)
      // NOTE: the store page loads /paynova.js, so it MUST be served here —
      // previously only /youpi.js was served and /paynova.js 404'd, which made
      // window.PayNova undefined and Buy Now fail with "reading 'pay'".
      if (pathname === '/paynova.js' || pathname === '/sdk/paynova.js') {
        const sdkPath = path.resolve(__dirname, '../../checkout-portal/src/sdk/paynova.js');
        if (fs.existsSync(sdkPath)) {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(fs.readFileSync(sdkPath, 'utf8'));
          return;
        }
      }

      // GET /youpi.js or /sdk/youpi-checkout.js (Universal Frontend Integration Script, legacy alias)
      if (pathname === '/youpi.js' || pathname === '/sdk/youpi-checkout.js' || pathname === '/sdk/youpi.js') {
        const sdkPath = path.resolve(__dirname, '../../checkout-portal/src/sdk/youpi.js');
        if (fs.existsSync(sdkPath)) {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(fs.readFileSync(sdkPath, 'utf8'));
          return;
        }
      }

      // GET /openapi.yaml (Public Developer Integration Specification)
      if (pathname === '/openapi.yaml') {
        const openApiPath = path.resolve(__dirname, '../../../openapi.yaml');
        if (fs.existsSync(openApiPath)) {
          res.writeHead(200, {
            'Content-Type': 'text/yaml; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(fs.readFileSync(openApiPath, 'utf8'));
          return;
        }
      }

      // REVERSE PROXY: /admin/* -> Merchant Admin (Port 6001), PASSWORD-GATED.
      // The admin panel has no login of its own, so the store is its only
      // public door: every request here must pass HTTP Basic Auth against
      // ADMIN_DASHBOARD_USER / ADMIN_DASHBOARD_PASSWORD. With no password
      // configured the door stays shut (503) instead of opening unguarded.
      // The /admin prefix is stripped so the admin page's own /api proxy
      // (which injects the server-side ADMIN_API_KEY) keeps working.
      if (pathname === '/admin' || pathname.startsWith('/admin/')) {
        const dashboardPassword = process.env.ADMIN_DASHBOARD_PASSWORD || '';
        if (!dashboardPassword) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Merchant admin access is not configured on this deployment.' }));
          return;
        }
        const dashboardUser = process.env.ADMIN_DASHBOARD_USER || 'admin';
        const authHeader = req.headers.authorization || '';
        let authorized = false;
        if (authHeader.startsWith('Basic ')) {
          let decoded = '';
          try { decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8'); } catch {}
          const sep = decoded.indexOf(':');
          const givenUser = sep >= 0 ? decoded.slice(0, sep) : decoded;
          const givenPass = sep >= 0 ? decoded.slice(sep + 1) : '';
          authorized = givenUser.length === dashboardUser.length
            && givenPass.length === dashboardPassword.length
            && crypto.timingSafeEqual(Buffer.from(givenUser, 'utf8'), Buffer.from(dashboardUser, 'utf8'))
            && crypto.timingSafeEqual(Buffer.from(givenPass, 'utf8'), Buffer.from(dashboardPassword, 'utf8'));
        }
        if (!authorized) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Basic realm="PayNova Merchant Admin"'
          });
          res.end(JSON.stringify({ error: 'Merchant admin authentication required.' }));
          return;
        }
        const adminPort = Number(process.env.MERCHANT_ADMIN_PORT || 6001);
        const stripped = pathname === '/admin' ? '/' : (pathname.slice('/admin'.length) || '/');
        const targetPath = stripped + (url.search || '');
        const adminHeaders = { ...req.headers, host: `localhost:${adminPort}` };
        delete adminHeaders.authorization; // Basic creds are for this gate only; admin injects its own server-side key downstream.
        // The gate above already verified the caller, so forward the server-side
        // admin key with the request: owner-admin browser calls that merchant-admin
        // guards with isAdminRequestAuthorized (e.g. logo upload) then pass, without
        // the key ever reaching the browser. Without a configured key nothing is added.
        if (process.env.ADMIN_API_KEY) adminHeaders['x-admin-api-key'] = process.env.ADMIN_API_KEY;
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: adminPort,
          path: targetPath,
          method: req.method,
          headers: adminHeaders
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Merchant Admin unavailable', details: err.message }));
          }
        });
        req.pipe(proxyReq);
        return;
      }

      // REVERSE PROXY: /gmail/oauth/callback -> Gmail Observer (Port 6003), PUBLIC.
      // Google redirects the owner's browser here after consent, so this
      // path CANNOT sit behind the /admin Basic-Auth gate: the redirect
      // carries no credentials. The observer's own /oauth/callback is
      // already unauthenticated on its port, so this proxy matches that
      // posture exactly; the code exchange still needs the server-side
      // GMAIL_CLIENT_SECRET, which never reaches the browser. Set
      // GMAIL_REDIRECT_URI to https://<public-host>/gmail/oauth/callback
      // on any public deployment, or Google refuses the redirect.
      if (pathname === '/gmail/oauth/callback') {
        const gmailPort = Number(process.env.GMAIL_OBSERVER_PORT || 6003);
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: gmailPort,
          path: '/oauth/callback' + (url.search || ''),
          method: req.method,
          headers: {
            ...req.headers,
            host: `localhost:${gmailPort}`,
            'x-forwarded-host': req.headers.host || '',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http'
          }
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Gmail observer unavailable', details: err.message }));
          }
        });
        req.pipe(proxyReq);
        return;
      }

      // REVERSE PROXY: /merchant/* -> Merchant Admin (Port 6001), PUBLIC.
      // Unlike /admin, this is NOT Basic-Auth gated: the login and
      // register pages must be reachable without credentials, and the
      // merchant session cookie (not a shared password) guards the rest.
      // The FULL path is forwarded (no prefix strip) so the merchant
      // portal's /merchant/api/* routes and cookie Path=/merchant line up.
      if (pathname === '/merchant' || pathname.startsWith('/merchant/')) {
        const merchantPort = Number(process.env.MERCHANT_ADMIN_PORT || 6001);
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: merchantPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `localhost:${merchantPort}`,
            'x-forwarded-host': req.headers.host || '',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http'
          }
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Merchant portal unavailable', details: err.message }));
          }
        });

        req.pipe(proxyReq);
        return;
      }

      // REVERSE PROXY: /checkout/* and /icons/* -> Checkout Portal (Port 7000)
      if (pathname.startsWith('/checkout') || pathname.startsWith('/icons/')) {
        const portalPort = Number(process.env.CHECKOUT_PORT || 7000);
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: portalPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `localhost:${portalPort}`,
            'x-forwarded-host': req.headers.host || '',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http'
          }
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Checkout Portal unavailable', details: err.message }));
          }
        });

        req.pipe(proxyReq);
        return;
      }

      // REVERSE PROXY: /api/v1/* -> Payment API (Port 6100 / gatewayApiUrl)
      if (pathname.startsWith('/api/v1/')) {
        try {
          const parsedGateway = new URL(this.gatewayApiUrl);
          const proxyReq = http.request({
            hostname: parsedGateway.hostname || '127.0.0.1',
            port: Number(parsedGateway.port || process.env.PAYMENT_API_PORT || 6100),
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              host: `${parsedGateway.hostname}:${parsedGateway.port}`,
              'x-forwarded-host': req.headers.host || '',
              'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http'
            }
          }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });

          proxyReq.on('error', (err) => {
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Payment Gateway API unavailable', details: err.message }));
            }
          });

          req.pipe(proxyReq);
          return;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to proxy payment API', details: err.message }));
          return;
        }
      }

      // GET / or /store
      if ((pathname === '/' || pathname === '/store') && (method === 'GET' || method === 'HEAD')) {
        try { this.storeHtml = fs.readFileSync(path.join(__dirname, 'store.html'), 'utf8'); } catch {}
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(this.storeHtml);
        return;
      }

      // GET /wallet
      if (pathname === '/wallet' && (method === 'GET' || method === 'HEAD')) {
        try { this.walletHtml = fs.readFileSync(path.join(__dirname, 'wallet.html'), 'utf8'); } catch {}
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(this.walletHtml);
        return;
      }

      // GET /privacy — demo privacy policy page (linked from admin Support & Legal)
      if (pathname === '/privacy' && (method === 'GET' || method === 'HEAD')) {
        try { this.privacyHtml = fs.readFileSync(path.join(__dirname, 'privacy.html'), 'utf8'); } catch {}
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(this.privacyHtml);
        return;
      }

      // GET /terms — demo terms of use page (linked from admin Support & Legal)
      if (pathname === '/terms' && (method === 'GET' || method === 'HEAD')) {
        try { this.termsHtml = fs.readFileSync(path.join(__dirname, 'terms.html'), 'utf8'); } catch {}
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(this.termsHtml);
        return;
      }

      // GET /order-success or /success
      if ((pathname === '/order-success' || pathname === '/success') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderSuccessHtml = fs.readFileSync(path.join(__dirname, 'order-success.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        const amount = url.searchParams.get('amount') || '499.00';
        const utr = url.searchParams.get('utr') || url.searchParams.get('bankRef') || '123456789012';
        const mode = url.searchParams.get('mode') || url.searchParams.get('payment_mode') || 'UPI';
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        let rendered = this.orderSuccessHtml
          .replaceAll('{{ORDER_ID}}', orderId)
          .replaceAll('{{AMOUNT}}', amount)
          .replaceAll('{{UTR}}', utr)
          .replaceAll('{{MODE}}', mode)
          .replaceAll('{{TIMESTAMP}}', timestamp);

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-failed or /failed
      if ((pathname === '/order-failed' || pathname === '/failed') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderFailedHtml = fs.readFileSync(path.join(__dirname, 'order-failed.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        const reason = url.searchParams.get('reason') || 'Transaction verification timed out or declined.';
        let rendered = this.orderFailedHtml
          .replaceAll('{{ORDER_ID}}', orderId)
          .replaceAll('ORDER-#', orderId)
          .replaceAll('{{REASON}}', reason);

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-suspicious or /suspicious
      if ((pathname === '/order-suspicious' || pathname === '/suspicious') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderSuspiciousHtml = fs.readFileSync(path.join(__dirname, 'order-suspicious.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        let rendered = this.orderSuspiciousHtml.replaceAll('{{ORDER_ID}}', orderId);

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-expired or /expired
      if ((pathname === '/order-expired' || pathname === '/expired') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderExpiredHtml = fs.readFileSync(path.join(__dirname, 'order-expired.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        let rendered = this.orderExpiredHtml.replaceAll('{{ORDER_ID}}', orderId);

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-cancelled or /cancelled
      if ((pathname === '/order-cancelled' || pathname === '/cancelled') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderCancelledHtml = fs.readFileSync(path.join(__dirname, 'order-cancelled.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        let rendered = this.orderCancelledHtml.replaceAll('{{ORDER_ID}}', orderId);

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /api/wallet-balance
      if (pathname === '/api/wallet-balance' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          coins: this.walletCoins,
          history: this.transactionHistory
        }));
        return;
      }

      // POST /api/checkout (Customer clicks purchase pack)
      if (pathname === '/api/checkout' && method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          let data;
          try {
            data = JSON.parse(body || '{}');
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON request body' }));
            return;
          }
          try {
            const rawVal = data.price !== undefined ? data.price : (data.amount !== undefined ? data.amount : 1.00);
            const price = Number(rawVal);
            if (isNaN(price) || price < 1) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Minimum top-up amount is ₹1.00' }));
              return;
            }
            const orderId = `COIN-ORD-${Date.now()}`;
            const amountStr = price.toFixed(2);
            const proto = req.headers['x-forwarded-proto'] || (req.headers.host?.includes('example.com') ? 'https' : 'http');
            const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:5000';
            const returnUrl = `${proto}://${host}/wallet?orderId=${orderId}`;

            // Call YOUPI Payment Gateway via SDK
            const payment = await this.paymentClient.createPayment({
              orderId,
              amount: amountStr,
              currency: 'INR',
              returnUrl,
              metadata: {
                coins: data.coins || Math.round(price),
                packName: data.packName || data.productName || 'Gamer Pack'
              }
            });

            // Checkout must ALWAYS go through this store's own public host, because
            // the store reverse-proxies /checkout/* to the checkout portal. The API's
            // raw checkoutUrl points at localhost:7000, which no visitor's browser
            // can reach — on any non-localhost deploy (Render, tunnel, LAN) that
            // produced a blank checkout modal. Previously this rewrite only ran
            // for localhost hosts, which is exactly backwards for production.
            const resolvedCheckoutUrl = `${proto}://${host}/checkout/${payment.paymentId}`;

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
              orderId,
              paymentId: payment.paymentId,
              checkoutUrl: resolvedCheckoutUrl
            }));
          } catch (err) {
            console.error('[Coin Wallet Store] Request failed:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request failed, please try again' }));
          }
        });
        return;
      }

      // Browser events are informational only. Fulfillment is webhook-only.
      if (pathname === '/api/verify-payment' && method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          let data;
          try {
            data = JSON.parse(body || '{}');
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON request body' }));
            return;
          }
          try {
            const { paymentId, orderId, coins, packName } = data;

            if (!orderId && !paymentId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing orderId or paymentId' }));
              return;
            }

            res.writeHead(410, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ success: false, error: 'Client-side confirmation disabled; await signed webhook.' }));
            return;

            /* Legacy client-side credit path intentionally disabled.
            // Check if already credited
            const alreadyCredited = this.transactionHistory.some(t => t.orderId === orderId);
            if (alreadyCredited) {
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              });
              res.end(JSON.stringify({ success: true, coins: this.walletCoins, message: 'Already credited' }));
              return;
            }

            // Verify with payment API if paymentId is available
            let creditedCoins = Number(coins) || 100;
            let finalPackName = packName || 'Coin Pack';

            if (paymentId) {
              try {
                const session = await this.paymentClient.getPayment(paymentId);
                if (session) {
                  if (session.metadata?.coins) creditedCoins = Number(session.metadata.coins);
                  if (session.metadata?.packName) finalPackName = session.metadata.packName;
                }
              } catch (e) {
                console.warn('[Coin Wallet Store] getPayment check note:', e.message);
              }
            }

            this.creditCoins(orderId, creditedCoins, finalPackName);
            console.log(`[Coin Wallet Store] Verified & credited ${creditedCoins} coins for Order ${orderId}. New balance: ${this.walletCoins}`);

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
              success: true,
              coins: this.walletCoins,
              credited: creditedCoins,
              packName: finalPackName
            })); */
          } catch (err) {
            console.error('[Coin Wallet Store] Request failed:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request failed, please try again' }));
          }
        });
        return;
      }

      // POST /api/webhook or /webhook (Signed webhook listener from PayNova)
      if ((pathname === '/api/webhook' || pathname === '/webhook') && method === 'POST') {
        let rawBody = '';
        req.on('data', chunk => { rawBody += chunk; });
        req.on('end', () => {
          const signature = req.headers['x-gateway-signature'];

          try {
            // Verify HMAC-SHA256 signature using merchant SDK
            const event = this.paymentClient.verifyWebhook(rawBody, signature);

            if (event.event === 'SUCCESS' || event.status === 'SUCCESS') {
              const orderId = event.orderId || event.data?.orderId;
              const alreadyCredited = this.transactionHistory.some(t => t.orderId === orderId);
              if (!alreadyCredited) {
                const coinsToAdd = Number(event.metadata?.coins || event.data?.metadata?.coins) || 100;
                const packName = event.metadata?.packName || event.data?.metadata?.packName || 'Coin Pack';
                this.creditCoins(orderId, coinsToAdd, packName);
                console.log(`[Coin Wallet Store] Webhook received! Credited ${coinsToAdd} coins for Order ${orderId}. New balance: ${this.walletCoins}`);
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, credited: true }));
          } catch (err) {
            console.error('[Coin Wallet Store] Webhook verification failed:', err.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Page not found · PayNova</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#0f172a;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}main{max-width:480px;text-align:center;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:40px 32px;box-shadow:0 8px 30px rgba(15,23,42,.08)}.shield{width:56px;height:64px;margin:0 auto 16px;background:linear-gradient(135deg,#0ea5e9,#0b63e5);border-radius:10px 10px 22px 22px;display:grid;place-items:center;color:#fff;font-weight:900;font-size:28px}h1{font-size:22px;margin:0 0 8px}p{color:#64748b;font-size:14px;line-height:1.6;margin:0 0 24px}a{display:inline-block;background:#0b63e5;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px}a.secondary{background:#fff;color:#0b63e5;border:1.5px solid #bfdbfe;margin-left:8px}</style></head>
<body><main><div class="shield">P</div><h1>Page not found</h1><p>The page you opened does not exist on the PayNova Store. Check the link and try again.</p><a href="/">Back to PayNova Store</a><a class="secondary" href="javascript:history.back()">Go back</a></main></body></html>`);
    });
  }
}
