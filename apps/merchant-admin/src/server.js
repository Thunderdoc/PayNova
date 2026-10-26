import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase, MerchantRepository, SupportTicketRepository } from '@youpi/db';

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

export class AdminServer {
  /**
   * @param {{
   *   db?: import('@youpi/db').Database,
   *   apiBaseUrl?: string
   * }} options
   */
  constructor(options = {}) {
    this.db = options.db || getDatabase();
    this.apiBaseUrl = options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.merchantRepo = new MerchantRepository(this.db);
    this.ticketRepo = new SupportTicketRepository(this.db);
    this.htmlTemplatePath = path.join(__dirname, 'views', 'admin.html');
    this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
  }

  renderHtml() {
    try {
      this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
    } catch {}

    let html = this.template;
    // Default '' so client calls hit the merchant admin's own /api proxy
    // (this eliminates CORS errors, tunnel downtime 530s, and cross-origin
    // failures). When the admin page is mounted under a path prefix on a
    // public host (e.g. /admin on the demo store), set ADMIN_API_BASE to
    // that prefix so every fetch/download link goes through the mount.
    const clientApiBase = process.env.ADMIN_API_BASE || '';
    html = html.replaceAll('{{API_BASE_URL}}', clientApiBase);
    return html;
  }

  isAdminRequestAuthorized(req) {
    if (process.env.NODE_ENV === 'test') return true;
    const configured = String(process.env.ADMIN_API_KEY || '');
    if (!configured) return process.env.NODE_ENV !== 'production';
    const provided = String(req.headers['x-admin-api-key'] || '').trim()
      || (String(req.headers.authorization || '').startsWith('Bearer ')
        ? String(req.headers.authorization).slice(7).trim()
        : '');
    const expected = Buffer.from(configured, 'utf8');
    const actual = Buffer.from(provided, 'utf8');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        return;
      }

      // Health
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'merchant-admin' }));
        return;
      }

      // Admin Tickets API: GET /api/admin/tickets
      if (pathname === '/api/admin/tickets') {
        if (!this.isAdminRequestAuthorized(req)) {
          res.writeHead(process.env.ADMIN_API_KEY ? 401 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: process.env.ADMIN_API_KEY ? 'Admin authentication required.' : 'Admin API is not configured for secure access.' }));
          return;
        }
        const merchants = this.merchantRepo.findAll();
        const mId = merchants[0]?.id || '00000000-0000-0000-0000-000000000001';
        const tickets = this.ticketRepo.findTicketsByMerchant(mId);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(tickets));
        return;
      }

      // Merged Control Center Supervisor Proxy: /api/services/* and /api/logs/stream -> Control Center on port 8090
      if (pathname.startsWith('/api/services') || pathname === '/api/logs/stream') {
        const ccPort = Number(process.env.CONTROL_CENTER_PORT || 8090);
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: ccPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `localhost:${ccPort}`
          }
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Control center supervisor unavailable', details: err.message }));
          }
        });

        req.on('data', chunk => proxyReq.write(chunk));
        req.on('end', () => proxyReq.end());
        return;
      }

      // Transparent API Proxy: /api/* -> Payment Core REST API
      if (pathname.startsWith('/api/')) {
        const targetPort = Number(process.env.PAYMENT_API_PORT || 6100);
        const defaultMerchant = this.merchantRepo.getDefault ? this.merchantRepo.getDefault() : (this.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || this.merchantRepo.findAll()[0]);
        const defaultMerchantId = defaultMerchant?.id || '00000000-0000-0000-0000-000000000001';
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            ...(process.env.ADMIN_API_KEY ? { 'x-admin-api-key': process.env.ADMIN_API_KEY } : {}),
            'x-merchant-id': req.headers['x-merchant-id'] || defaultMerchantId,
            host: `localhost:${targetPort}`,
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
            res.end(JSON.stringify({ error: 'Gateway API unavailable', details: err.message }));
          }
        });

        req.pipe(proxyReq);
        return;
      }

      // Download Android Companion APK
      if (pathname === '/youpi-sms-gateway.apk' || pathname === '/api/v1/admin/sms-gateway/download-apk') {
        if (pathname.startsWith('/api/') && !this.isAdminRequestAuthorized(req)) {
          res.writeHead(process.env.ADMIN_API_KEY ? 401 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: process.env.ADMIN_API_KEY ? 'Admin authentication required.' : 'Admin API is not configured for secure access.' }));
          return;
        }
        const apkCandidates = [
          path.resolve(__dirname, '../public/youpi-sms-gateway.apk'),
          path.resolve(__dirname, '../../payment-api/public/youpi-sms-gateway.apk'),
          path.resolve(__dirname, '../../android-observer-app/youpi-sms-gateway.apk')
        ];
        let apkPath = null;
        for (const p of apkCandidates) {
          if (fs.existsSync(p)) {
            apkPath = p;
            break;
          }
        }
        if (apkPath) {
          const stat = fs.statSync(apkPath);
          res.writeHead(200, {
            'Content-Type': 'application/vnd.android.package-archive',
            'Content-Disposition': 'attachment; filename="youpi-sms-gateway.apk"',
            'Content-Length': stat.size,
            'Access-Control-Allow-Origin': '*'
          });
          const stream = fs.createReadStream(apkPath);
          stream.pipe(res);
          return;
        }
      }

      // Dashboard View: GET / or GET /admin
      if (pathname === '/' || pathname === '/admin') {
        const html = this.renderHtml();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.end(html);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Page not found · PayNova</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#0f172a;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}main{max-width:480px;text-align:center;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:40px 32px;box-shadow:0 8px 30px rgba(15,23,42,.08)}.shield{width:56px;height:64px;margin:0 auto 16px;background:linear-gradient(135deg,#0ea5e9,#0b63e5);border-radius:10px 10px 22px 22px;display:grid;place-items:center;color:#fff;font-weight:900;font-size:28px}h1{font-size:22px;margin:0 0 8px}p{color:#64748b;font-size:14px;line-height:1.6;margin:0 0 24px}a{display:inline-block;background:#0b63e5;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px}a.secondary{background:#fff;color:#0b63e5;border:1.5px solid #bfdbfe;margin-left:8px}</style></head>
<body><main><div class="shield">P</div><h1>Page not found</h1><p>This merchant admin page does not exist.</p><a href="/admin">Back to Merchant Admin</a><a class="secondary" href="javascript:history.back()">Go back</a></main></body></html>`);
    });
  }
}
