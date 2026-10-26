import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '@youpi/db';
import { startAdminServer } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.resolve(__dirname, '..', '..', 'public', 'uploads');

// 1x1 transparent PNG (real magic bytes, tiny body)
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64'
);

function multipart(fieldName, filename, contentType, body) {
  const boundary = '----paynova-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, body, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

describe('Brand logo image upload', () => {
  let serverInstance;
  let baseUrl;
  let testDb;
  const created = [];

  before(async () => {
    testDb = new Database({ inMemory: true });
    serverInstance = await startAdminServer(6105, { db: testDb });
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    await serverInstance.close();
    testDb.close();
    for (const f of created) {
      try { fs.unlinkSync(path.join(uploadsDir, path.basename(f))); } catch {}
    }
  });

  function request(method, urlPath, body, contentType) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${urlPath}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': contentType, 'Content-Length': body.length } : {})
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  test('real PNG upload returns 200 + a URL that loads 200', async () => {
    const { body, contentType } = multipart('logo', 'logo.png', 'image/png', TINY_PNG);
    const res = await request('POST', '/api/admin/branding-logo', body, contentType);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body.toString('utf8'));
    assert.ok(data.url.startsWith('/uploads/'), `unexpected url ${data.url}`);
    created.push(data.url);
    const get = await request('GET', data.url);
    assert.equal(get.status, 200);
    assert.equal(get.headers['content-type'], 'image/png');
    assert.deepEqual(get.body, TINY_PNG);
  });

  test('non-image file is rejected with 400', async () => {
    const { body, contentType } = multipart('logo', 'notes.txt', 'text/plain', Buffer.from('hello, not an image'));
    const res = await request('POST', '/api/admin/branding-logo', body, contentType);
    assert.equal(res.status, 400);
  });

  test('SVG content is rejected with 400 (script-carrying vector, not a raster image)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const { body, contentType } = multipart('logo', 'logo.svg', 'image/svg+xml', svg);
    const res = await request('POST', '/api/admin/branding-logo', body, contentType);
    assert.equal(res.status, 400);
  });

  test('oversized image is rejected with 400', async () => {
    const big = Buffer.concat([TINY_PNG, Buffer.alloc(2 * 1024 * 1024, 0)]);
    const { body, contentType } = multipart('logo', 'big.png', 'image/png', big);
    const res = await request('POST', '/api/admin/branding-logo', body, contentType);
    assert.equal(res.status, 400);
  });

  test('path traversal on the public read route is 404', async () => {
    const res = await request('GET', '/uploads/..%2F..%2Fserver.js');
    assert.equal(res.status, 404);
  });

  test('admin page still loads 200 with the upload UI present', async () => {
    const res = await request('GET', '/');
    assert.equal(res.status, 200);
    const html = res.body.toString('utf8');
    assert.ok(html.includes('id="btnUploadLogo"'));
    assert.ok(html.includes('id="logoUploadInput"'));
    assert.ok(html.includes('id="logoUploadPreview"'));
    assert.ok(html.includes('id="settingLogoUrl"'));
  });
});
