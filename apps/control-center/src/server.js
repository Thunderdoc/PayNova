import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessManager } from './process-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ControlCenterServer {
  /**
   * @param {{ processManager?: ProcessManager }} [options={}]
   */
  constructor(options = {}) {
    this.processManager = options.processManager || new ProcessManager();
    this.htmlTemplatePath = path.join(__dirname, 'views', 'dashboard.html');
    this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
    this.sseClients = new Set();

    // Broadcast log events to all connected SSE clients
    this.processManager.on('log', (logEntry) => {
      this.broadcastSse('log', logEntry);
    });

    this.processManager.on('status_change', (change) => {
      this.broadcastSse('status_change', change);
    });
  }

  broadcastSse(event, data) {
    if (this.sseClients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
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
          'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
      }

      // GET /health
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'control-center' }));
        return;
      }

      // GET /api/services
      if (pathname === '/api/services' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(this.processManager.getServicesStatus()));
        return;
      }

      // POST /api/services/start-all
      if (pathname === '/api/services/start-all' && method === 'POST') {
        await this.processManager.startAll();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, message: 'All services starting' }));
        return;
      }

      // POST /api/services/stop-all
      if (pathname === '/api/services/stop-all' && method === 'POST') {
        await this.processManager.stopAll();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, message: 'All services stopping' }));
        return;
      }

      // POST /api/services/:id/start
      const startMatch = pathname.match(/^\/api\/services\/([a-zA-Z0-9_\-]+)\/start$/);
      if (startMatch && method === 'POST') {
        const id = startMatch[1];
        try {
          const svc = await this.processManager.startService(id);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: true, service: svc.id, status: svc.status }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // POST /api/services/:id/stop
      const stopMatch = pathname.match(/^\/api\/services\/([a-zA-Z0-9_\-]+)\/stop$/);
      if (stopMatch && method === 'POST') {
        const id = stopMatch[1];
        try {
          const svc = await this.processManager.stopService(id);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: true, service: svc.id, status: svc.status }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // POST /api/services/:id/restart
      const restartMatch = pathname.match(/^\/api\/services\/([a-zA-Z0-9_\-]+)\/restart$/);
      if (restartMatch && method === 'POST') {
        const id = restartMatch[1];
        try {
          const svc = await this.processManager.restartService(id);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: true, service: svc.id, status: svc.status }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // GET /api/logs/stream (SSE)
      if (pathname === '/api/logs/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });

        // Send existing logs
        for (const log of this.processManager.logs.slice(-50)) {
          res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`);
        }

        this.sseClients.add(res);

        const pingTimer = setInterval(() => {
          try { res.write(': keepalive\n\n'); } catch { clearInterval(pingTimer); }
        }, 15000);

        res.on('close', () => {
          clearInterval(pingTimer);
          this.sseClients.delete(res);
        });
        return;
      }

      // Web Dashboard View: GET /
      if (pathname === '/' || pathname === '/dashboard') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.end(this.template);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Page not found · PayNova</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#0f172a;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}main{max-width:480px;text-align:center;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:40px 32px;box-shadow:0 8px 30px rgba(15,23,42,.08)}.shield{width:56px;height:64px;margin:0 auto 16px;background:linear-gradient(135deg,#0ea5e9,#0b63e5);border-radius:10px 10px 22px 22px;display:grid;place-items:center;color:#fff;font-weight:900;font-size:28px}h1{font-size:22px;margin:0 0 8px}p{color:#64748b;font-size:14px;line-height:1.6;margin:0 0 24px}a{display:inline-block;background:#0b63e5;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px}a.secondary{background:#fff;color:#0b63e5;border:1.5px solid #bfdbfe;margin-left:8px}</style></head>
<body><main><div class="shield">P</div><h1>Page not found</h1><p>This control center page does not exist.</p><a href="/">Back to Control Center</a><a class="secondary" href="javascript:history.back()">Go back</a></main></body></html>`);
    });
  }
}
