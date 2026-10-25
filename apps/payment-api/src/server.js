import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';

/**
 * Lightweight, high-performance HTTP router and server with native SSE and CORS.
 */
export class HttpServer {
  constructor() {
    this.routes = [];
    this.sseClients = new Map(); // sessionId -> Set of res objects
    this.allowedOrigins = new Set((process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5000,http://localhost:7000,http://localhost:6001')
      .split(',').map(value => value.trim()).filter(Boolean));
  }

  originFor(req) {
    const origin = req?.headers?.origin;
    if (process.env.NODE_ENV === 'test') return '*';
    return origin && this.allowedOrigins.has(origin) ? origin : 'null';
  }

  /**
   * Registers a route.
   * @param {'GET'|'POST'|'PUT'|'DELETE'} method
   * @param {string} pattern E.g. "/api/v1/checkout/:id/state"
   * @param {(req: any, res: any, params: Record<string, string>) => void} handler
   */
  register(method, pattern, handler) {
    const paramNames = [];
    const regexPattern = pattern.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });

    this.routes.push({
      method: method.toUpperCase(),
      regex: new RegExp(`^${regexPattern}$`),
      paramNames,
      handler
    });
  }

  get(pattern, handler) {
    this.register('GET', pattern, handler);
  }

  post(pattern, handler) {
    this.register('POST', pattern, handler);
  }

  delete(pattern, handler) {
    this.register('DELETE', pattern, handler);
  }

  /**
   * Dispatches SSE event to all connected clients listening on a specific topic/key.
   * @param {string} topic
   * @param {string} event
   * @param {any} data
   */
  broadcastSse(topic, event, data) {
    const clients = this.sseClients.get(topic);
    if (!clients || clients.size === 0) return;

    const safeJson = (obj) => JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? v.toString() : v);
    const namedPayload = `event: ${event}\ndata: ${safeJson(data)}\n\n`;
    const defaultPayload = `data: ${safeJson({ type: event, ...data, event })}\n\n`;
    const combinedPayload = namedPayload + defaultPayload;
    for (const res of clients) {
      try {
        res.write(combinedPayload);
      } catch {
        clients.delete(res);
      }
    }
  }

  /**
   * Sets up SSE connection for a client response.
   * @param {string} topic
   * @param {http.ServerResponse} res
   */
  initSse(topic, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': res.__corsOrigin || '*'
    });

    res.write('event: connected\ndata: {"status":"connected"}\n\n');

    if (!this.sseClients.has(topic)) {
      this.sseClients.set(topic, new Set());
    }
    const set = this.sseClients.get(topic);
    set.add(res);

    // Keepalive ping every 15s
    const pingInterval = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(pingInterval);
      }
    }, 15000);

    res.on('close', () => {
      clearInterval(pingInterval);
      set.delete(res);
      if (set.size === 0) {
        this.sseClients.delete(topic);
      }
    });
  }

  /**
   * Helper to send JSON responses with standard headers.
   */
  static json(res, statusCode, data) {
    const jsonStr = JSON.stringify(data, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': res.__corsOrigin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key, X-Device-Id, X-Timestamp, X-Signature'
    });
    res.end(jsonStr);
  }

  /**
   * Parses JSON body from request.
   */
  static async parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) { // 2MB limit
          reject(new Error('Payload Too Large'));
        }
      });
      req.on('end', () => {
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Malformed JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Protects the entire merchant-admin API surface. The secret is only
   * accepted server-to-server; it is never rendered into the admin page.
   * Local development remains usable without a key, while production fails
   * closed if the key has not been configured.
   */
  adminAuthorization(req, pathname) {
    if (!pathname.startsWith('/api/v1/admin/')) return { allowed: true };
    if (process.env.NODE_ENV === 'test') return { allowed: true };

    const configuredKey = process.env.ADMIN_API_KEY || '';
    if (!configuredKey) {
      if (process.env.NODE_ENV === 'production') {
        return { allowed: false, status: 503, message: 'Admin API is not configured for secure access.' };
      }
      return { allowed: true };
    }

    const presented = String(req.headers['x-admin-api-key'] || '').trim()
      || (String(req.headers.authorization || '').startsWith('Bearer ')
        ? String(req.headers.authorization).slice(7).trim()
        : '');
    const expected = Buffer.from(configuredKey, 'utf8');
    const actual = Buffer.from(presented, 'utf8');
    const valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    return valid
      ? { allowed: true }
      : { allowed: false, status: 401, message: 'Admin authentication required.' };
  }

  /**
   * Sliding window IP rate limiter (Zero external dependencies).
   * @param {string} ip
   * @param {string} pathname
   * @returns {boolean} true if allowed, false if rate limit exceeded
   */
  checkRateLimit(ip, pathname) {
    if (!this.rateLimitMap) this.rateLimitMap = new Map();
    const now = Date.now();

    // Sensitive endpoints have tighter bounds
    const isSensitive = pathname.includes('/otp') || pathname.includes('/send-otp') || pathname.includes('/verify-otp');
    const limit = isSensitive ? 30 : 300; // 30 req/min for OTP, 300 req/min for general API
    const windowMs = 60000;

    const key = `${ip}:${isSensitive ? 'auth' : 'api'}`;
    let record = this.rateLimitMap.get(key);
    if (!record || now - record.start > windowMs) {
      record = { start: now, count: 1 };
      this.rateLimitMap.set(key, record);
      return true;
    }

    record.count++;
    if (record.count > limit) {
      return false;
    }
    return true;
  }

  /**
   * Creates native HTTP server.
   */
  createServer() {
    return http.createServer(async (req, res) => {
      // Handle CORS preflight
      const corsOrigin = this.originFor(req);
      res.__corsOrigin = corsOrigin;
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key, X-Device-Id, X-Timestamp, X-Signature, X-PayNova-Signature, X-Hackastra-Signature'
        });
        res.end();
        return;
      }

      const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      const adminAuth = this.adminAuthorization(req, pathname);
      if (!adminAuth.allowed) {
        HttpServer.json(res, adminAuth.status, { error: adminAuth.message });
        return;
      }

      // Rate limit check
      if (process.env.NODE_ENV !== 'test' && !this.checkRateLimit(clientIp, pathname)) {
        HttpServer.json(res, 429, {
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Please try again shortly.'
        });
        return;
      }
      const method = req.method.toUpperCase();

      for (const route of this.routes) {
        if (route.method === method) {
          const match = pathname.match(route.regex);
          if (match) {
            const params = {};
            route.paramNames.forEach((name, index) => {
              params[name] = match[index + 1];
            });

            req.query = Object.fromEntries(parsedUrl.searchParams.entries());

            try {
              await route.handler(req, res, params);
            } catch (err) {
              console.error(`Route Error [${method} ${pathname}]:`, err);
              HttpServer.json(res, 500, { error: err.message || 'Internal Server Error' });
            }
            return;
          }
        }
      }

      // Not found
      HttpServer.json(res, 404, { error: `Route not found: ${method} ${pathname}` });
    });
  }
}
