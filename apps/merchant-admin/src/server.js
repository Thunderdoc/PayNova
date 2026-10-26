import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase, MerchantRepository, MerchantUserRepository, PaymentSessionRepository, ReceivingAccountRepository, SupportTicketRepository } from '@youpi/db';
import {
  MERCHANT_SESSION_TTL_MS,
  clearLoginFailures,
  clearSessionCookieHeader,
  clientIp,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  isLoginRateLimited,
  isValidEmail,
  parseSessionCookie,
  recordLoginFailure,
  sessionCookieHeader,
  slugifyBusinessName,
  verifyPassword
} from './merchant-auth.js';

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
    this.merchantUserRepo = new MerchantUserRepository(this.db);
    this.paymentRepo = new PaymentSessionRepository(this.db);
    this.accountRepo = new ReceivingAccountRepository(this.db);
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

  // ---- Brand logo image upload (owner admin only) ----
  // No multipart library is used: the single-file body is parsed by hand
  // (boundary + file bytes). SVG is rejected: it can carry scripts, and
  // only raster images are verified here by magic bytes, never by extension.
  uploadsDir() {
    return path.resolve(__dirname, '..', 'public', 'uploads');
  }

  detectUploadImage(buf) {
    if (buf.length >= 8
      && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
      return { ext: 'png', contentType: 'image/png' };
    }
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return { ext: 'jpg', contentType: 'image/jpeg' };
    }
    if (buf.length >= 6) {
      const head = buf.subarray(0, 6).toString('ascii');
      if (head === 'GIF87a' || head === 'GIF89a') return { ext: 'gif', contentType: 'image/gif' };
    }
    if (buf.length >= 12
      && buf.subarray(0, 4).toString('ascii') === 'RIFF'
      && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
      return { ext: 'webp', contentType: 'image/webp' };
    }
    return null;
  }

  // Returns the raw bytes of the form field named "logo", or throws.
  parseMultipartLogo(body, boundary) {
    const sep = Buffer.from('--' + boundary);
    let idx = body.indexOf(sep);
    while (idx !== -1) {
      let pos = idx + sep.length;
      if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // closing boundary
      if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
      const headerEnd = body.indexOf('\r\n\r\n', pos);
      if (headerEnd === -1) break;
      const headers = body.subarray(pos, headerEnd).toString('latin1');
      const dataStart = headerEnd + 4;
      const next = body.indexOf(sep, dataStart);
      if (next === -1) break;
      const dataEnd = Math.max(dataStart, next - 2); // strip trailing CRLF
      const m = /Content-Disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
      if (m && m[1] === 'logo' && m[2]) return body.subarray(dataStart, dataEnd);
      idx = next;
    }
    throw new Error('No image file in upload');
  }

  async handleBrandingLogoUpload(req, res) {
    const sendJson = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    if (!this.isAdminRequestAuthorized(req)) {
      sendJson(process.env.ADMIN_API_KEY ? 401 : 503, {
        error: process.env.ADMIN_API_KEY ? 'Admin authentication required.' : 'Admin API is not configured for secure access.'
      });
      return;
    }
    const contentType = String(req.headers['content-type'] || '');
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
    if (!contentType.startsWith('multipart/form-data') || !boundaryMatch) {
      sendJson(400, { error: 'Upload must be a multipart image file.' });
      return;
    }
    const boundary = (boundaryMatch[1] || boundaryMatch[2]).trim();
    const MAX_FILE_BYTES = 2 * 1024 * 1024;
    const BODY_CAP = MAX_FILE_BYTES + 256 * 1024; // file + multipart overhead
    const chunks = [];
    let total = 0;
    let overCap = false;
    await new Promise((resolve) => {
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total <= BODY_CAP) chunks.push(chunk);
        else overCap = true; // keep draining, but do not buffer unbounded input
      });
      req.on('end', resolve);
      req.on('error', resolve);
    });
    if (overCap) {
      sendJson(400, { error: 'Image must be 2 MB or smaller.' });
      return;
    }
    let fileBytes;
    try {
      fileBytes = this.parseMultipartLogo(Buffer.concat(chunks), boundary);
    } catch (e) {
      sendJson(400, { error: e.message || 'Invalid upload.' });
      return;
    }
    if (fileBytes.length === 0) {
      sendJson(400, { error: 'Uploaded file is empty.' });
      return;
    }
    if (fileBytes.length > MAX_FILE_BYTES) {
      sendJson(400, { error: 'Image must be 2 MB or smaller.' });
      return;
    }
    const detected = this.detectUploadImage(fileBytes);
    if (!detected) {
      sendJson(400, { error: 'Only PNG, JPEG, WebP or GIF images are allowed.' });
      return;
    }
    const filename = crypto.randomBytes(16).toString('hex') + '.' + detected.ext;
    try {
      const dir = this.uploadsDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, filename), fileBytes);
    } catch {
      sendJson(500, { error: 'Failed to store uploaded image.' });
      return;
    }
    sendJson(200, { url: '/uploads/' + filename });
  }

  serveUploadedLogo(res, pathname) {
    const name = pathname.slice('/uploads/'.length);
    const send404 = () => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    };
    if (!/^[A-Za-z0-9_-]+\.(png|jpg|jpeg|gif|webp)$/.test(name)) {
      send404();
      return;
    }
    const dir = this.uploadsDir();
    const file = path.resolve(dir, name);
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) {
      send404();
      return;
    }
    const ext = name.split('.').pop().toLowerCase();
    const type = ext === 'png' ? 'image/png'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    fs.createReadStream(file).pipe(res);
  }

  // ---- Merchant portal (self-serve registration + login) ----
  // These routes are deliberately separate from the owner dashboard:
  // a merchant session cookie is never accepted for / or /admin, and
  // every merchant API call is scoped to the session's own merchant_id.
  // Client-supplied merchant ids are never trusted.

  readMerchantView(filename) {
    return fs.readFileSync(path.join(__dirname, 'views', filename), 'utf8');
  }

  sendMerchantJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        if (!raw.trim()) { resolve({}); return; }
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON request body')); }
      });
      req.on('error', reject);
    });
  }

  resolveMerchantSession(req) {
    const token = parseSessionCookie(req);
    if (!token) return null;
    const session = this.merchantUserRepo.findByTokenHash(hashSessionToken(token));
    if (!session) return null;
    const user = this.merchantUserRepo.findById(session.merchantUserId);
    if (!user) return null;
    const merchant = this.merchantRepo.findById(user.merchantId);
    if (!merchant) return null;
    return { session, user, merchant, token };
  }

  startMerchantSession(req, res, user) {
    const { token, tokenHash } = createSessionToken();
    this.merchantUserRepo.createSession({
      merchantUserId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + MERCHANT_SESSION_TTL_MS),
      ipAddress: clientIp(req),
      userAgent: req.headers?.['user-agent'] || ''
    });
    res.setHeader('Set-Cookie', sessionCookieHeader(token, req));
    return token;
  }

  publicMerchant(merchant) {
    return {
      id: merchant.id,
      businessName: merchant.businessName,
      contactEmail: merchant.contactEmail,
      contactPhone: merchant.contactPhone,
      webhookUrl: merchant.webhookUrl,
      slug: merchant.slug
    };
  }

  async handleMerchantRoutes(req, res, pathname) {
    const method = req.method.toUpperCase();

    // Public pages -------------------------------------------------------
    if (pathname === '/merchant') {
      const session = this.resolveMerchantSession(req);
      res.writeHead(302, { Location: session ? '/merchant/dashboard' : '/merchant/login' });
      res.end();
      return true;
    }
    if (pathname === '/merchant/login' || pathname === '/merchant/register') {
      if (method !== 'GET') { this.sendMerchantJson(res, 405, { error: 'Method not allowed.' }); return true; }
      if (this.resolveMerchantSession(req)) {
        res.writeHead(302, { Location: '/merchant/dashboard' });
        res.end();
        return true;
      }
      const view = pathname === '/merchant/login' ? 'merchant-login.html' : 'merchant-register.html';
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(this.readMerchantView(view));
      } catch {
        this.sendMerchantJson(res, 500, { error: 'Merchant page unavailable.' });
      }
      return true;
    }
    if (pathname === '/merchant/dashboard') {
      if (method !== 'GET') { this.sendMerchantJson(res, 405, { error: 'Method not allowed.' }); return true; }
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(this.readMerchantView('merchant-dashboard.html'));
      } catch {
        this.sendMerchantJson(res, 500, { error: 'Merchant page unavailable.' });
      }
      return true;
    }

    if (!pathname.startsWith('/merchant/api/')) return false;
    const apiPath = pathname.slice('/merchant/api'.length);

    // Registration -------------------------------------------------------
    if (apiPath === '/register') {
      if (method !== 'POST') { this.sendMerchantJson(res, 405, { error: 'Method not allowed.' }); return true; }
      let body;
      try { body = await this.readJsonBody(req); } catch (e) { this.sendMerchantJson(res, 400, { error: e.message }); return true; }
      const name = String(body.name || '').trim();
      const businessName = String(body.businessName || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const phone = String(body.phone || '').trim();
      const password = String(body.password || '');
      if (!name) { this.sendMerchantJson(res, 400, { error: 'Your name is required.' }); return true; }
      if (!businessName) { this.sendMerchantJson(res, 400, { error: 'Business name is required.' }); return true; }
      if (!isValidEmail(email)) { this.sendMerchantJson(res, 400, { error: 'A valid email address is required.' }); return true; }
      if (password.length < 8) { this.sendMerchantJson(res, 400, { error: 'Password must be at least 8 characters.' }); return true; }
      if (this.merchantUserRepo.findByEmail(email)) {
        this.sendMerchantJson(res, 409, { error: 'An account with this email already exists.' });
        return true;
      }
      let slug = null;
      for (let attempt = 0; attempt < 5 && !slug; attempt++) {
        const candidate = `${slugifyBusinessName(businessName)}-${crypto.randomBytes(3).toString('hex')}`;
        if (!this.merchantRepo.findBySlug(candidate)) slug = candidate;
      }
      if (!slug) { this.sendMerchantJson(res, 500, { error: 'Could not create merchant. Please try again.' }); return true; }
      const merchant = this.merchantRepo.create({
        businessName, slug, contactEmail: email, contactPhone: phone, webhookUrl: null
      });
      const user = this.merchantUserRepo.create({
        merchantId: merchant.id, name, email, passwordHash: hashPassword(password)
      });
      this.startMerchantSession(req, res, user);
      this.sendMerchantJson(res, 201, {
        merchant: { id: merchant.id, businessName: merchant.businessName },
        user: { name: user.name, email: user.email }
      });
      return true;
    }

    // Login --------------------------------------------------------------
    if (apiPath === '/login') {
      if (method !== 'POST') { this.sendMerchantJson(res, 405, { error: 'Method not allowed.' }); return true; }
      let body;
      try { body = await this.readJsonBody(req); } catch (e) { this.sendMerchantJson(res, 400, { error: e.message }); return true; }
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (isLoginRateLimited(req, email)) {
        this.sendMerchantJson(res, 429, { error: 'Too many failed login attempts. Please try again later.' });
        return true;
      }
      const authUser = this.merchantUserRepo.findByEmailForAuth(email);
      if (!authUser || !verifyPassword(password, authUser.passwordHash)) {
        recordLoginFailure(req, email);
        this.sendMerchantJson(res, 401, { error: 'Invalid email or password.' });
        return true;
      }
      clearLoginFailures(req, email);
      const user = this.merchantUserRepo.findById(authUser.id);
      const merchant = this.merchantRepo.findById(user.merchantId);
      this.startMerchantSession(req, res, user);
      this.sendMerchantJson(res, 200, {
        merchant: { id: merchant.id, businessName: merchant.businessName },
        user: { name: user.name, email: user.email }
      });
      return true;
    }

    // Everything below requires a valid merchant session -----------------
    const session = this.resolveMerchantSession(req);
    if (!session) {
      this.sendMerchantJson(res, 401, { error: 'Merchant authentication required.' });
      return true;
    }
    const { user, merchant } = session;

    if (apiPath === '/logout') {
      if (method !== 'POST') { this.sendMerchantJson(res, 405, { error: 'Method not allowed.' }); return true; }
      this.merchantUserRepo.revokeSessionByTokenHash(hashSessionToken(session.token));
      res.setHeader('Set-Cookie', clearSessionCookieHeader(req));
      this.sendMerchantJson(res, 200, { ok: true });
      return true;
    }

    if (apiPath === '/me') {
      if (method === 'GET') {
        this.sendMerchantJson(res, 200, {
          merchant: this.publicMerchant(merchant),
          user: { name: user.name, email: user.email }
        });
        return true;
      }
      if (method === 'PATCH') {
        let body;
        try { body = await this.readJsonBody(req); } catch (e) { this.sendMerchantJson(res, 400, { error: e.message }); return true; }
        const updates = {};
        if (body.businessName !== undefined) {
          const next = String(body.businessName || '').trim();
          if (!next) { this.sendMerchantJson(res, 400, { error: 'Business name is required.' }); return true; }
          updates.businessName = next;
        }
        if (body.contactPhone !== undefined) updates.contactPhone = String(body.contactPhone || '').trim();
        if (body.webhookUrl !== undefined) {
          const next = String(body.webhookUrl || '').trim();
          updates.webhookUrl = next === '' ? null : next;
        }
        const updated = this.merchantRepo.update(merchant.id, updates);
        this.sendMerchantJson(res, 200, {
          merchant: this.publicMerchant(updated),
          user: { name: user.name, email: user.email }
        });
        return true;
      }
      this.sendMerchantJson(res, 405, { error: 'Method not allowed.' });
      return true;
    }

    if (apiPath === '/payments') {
      if (method !== 'GET') { this.sendMerchantJson(res, 405, { error: 'Method not allowed.' }); return true; }
      const payments = this.paymentRepo.findByMerchantId(merchant.id, 50).map(p => ({
        id: p.id,
        orderId: p.orderId,
        amountPaise: Number(p.amountPaise),
        currency: p.currency,
        method: p.method,
        status: p.status,
        createdAt: p.createdAt
      }));
      this.sendMerchantJson(res, 200, { payments });
      return true;
    }

    if (apiPath === '/accounts') {
      if (method === 'GET') {
        const accounts = this.accountRepo.findByMerchantId(merchant.id).map(a => ({
          id: a.id,
          upiId: a.upiId,
          payeeName: a.payeeName,
          isActive: a.isActive,
          isMerchantEnabled: a.isMerchantEnabled,
          createdAt: a.createdAt
        }));
        this.sendMerchantJson(res, 200, { accounts });
        return true;
      }
      if (method === 'POST') {
        let body;
        try { body = await this.readJsonBody(req); } catch (e) { this.sendMerchantJson(res, 400, { error: e.message }); return true; }
        const upiId = String(body.upiId || '').trim();
        const payeeName = String(body.payeeName || '').trim();
        if (!upiId.includes('@')) { this.sendMerchantJson(res, 400, { error: 'A valid UPI ID (containing @) is required.' }); return true; }
        if (!payeeName) { this.sendMerchantJson(res, 400, { error: 'Payee name is required.' }); return true; }
        const account = this.accountRepo.create({ merchantId: merchant.id, upiId, payeeName });
        this.sendMerchantJson(res, 201, {
          account: {
            id: account.id,
            upiId: account.upiId,
            payeeName: account.payeeName,
            isActive: account.isActive,
            isMerchantEnabled: account.isMerchantEnabled,
            createdAt: account.createdAt
          }
        });
        return true;
      }
      this.sendMerchantJson(res, 405, { error: 'Method not allowed.' });
      return true;
    }

    const activateMatch = apiPath.match(/^\/accounts\/([^/]+)\/activate$/);
    if (activateMatch) {
      if (method !== 'POST') { this.sendMerchantJson(res, 405, { error: 'Method not allowed.' }); return true; }
      const account = this.accountRepo.findById(activateMatch[1]);
      if (!account || account.merchantId !== merchant.id) {
        this.sendMerchantJson(res, 404, { error: 'Account not found.' });
        return true;
      }
      const updated = this.accountRepo.activateAccount(merchant.id, account.id);
      this.sendMerchantJson(res, 200, {
        account: {
          id: updated.id,
          upiId: updated.upiId,
          payeeName: updated.payeeName,
          isActive: updated.isActive,
          isMerchantEnabled: updated.isMerchantEnabled,
          createdAt: updated.createdAt
        }
      });
      return true;
    }

    this.sendMerchantJson(res, 404, { error: 'Merchant API route not found.' });
    return true;
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

      // Brand logo image upload (owner admin only). Must stay BEFORE the
      // generic /api proxy below, or it would be forwarded to payment-api.
      if (pathname === '/api/admin/branding-logo' && req.method === 'POST') {
        await this.handleBrandingLogoUpload(req, res);
        return;
      }

      // Uploaded brand logos (public read; upload itself is admin-gated).
      if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
        this.serveUploadedLogo(res, pathname);
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

      // Merchant portal routes (self-serve registration + login). These
      // MUST be checked before the generic /api proxy below, and they are
      // scoped to the merchant session — never to owner routes.
      if (pathname === '/merchant' || pathname.startsWith('/merchant/')) {
        if (await this.handleMerchantRoutes(req, res, pathname)) return;
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
