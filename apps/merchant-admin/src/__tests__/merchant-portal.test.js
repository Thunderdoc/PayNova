import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database, PaymentSessionRepository, ReceivingAccountRepository } from '@youpi/db';
import { startAdminServer } from '../index.js';

describe('Merchant Portal Integration Tests', () => {
  let serverInstance;
  let baseUrl;
  let testDb;
  let paymentRepo;
  let accountRepo;

  before(async () => {
    testDb = new Database({ inMemory: true });
    serverInstance = await startAdminServer(6102, { db: testDb });
    baseUrl = `http://localhost:${serverInstance.port}`;
    paymentRepo = new PaymentSessionRepository(testDb);
    accountRepo = new ReceivingAccountRepository(testDb);
  });

  after(async () => {
    await serverInstance.close();
    testDb.close();
  });

  function request(method, path, body, cookie) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: cookie } : {})
        }
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  function sessionCookieFrom(res) {
    const setCookie = res.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie) && setCookie.length > 0, 'expected Set-Cookie header');
    return setCookie[0].split(';')[0];
  }

  async function registerMerchant(suffix) {
    const res = await request('POST', '/merchant/api/register', {
      name: `Test Owner ${suffix}`,
      businessName: `Test Business ${suffix}`,
      email: `owner-${suffix}@example.com`,
      phone: '9876543210',
      password: 'correct-horse-123'
    });
    assert.equal(res.status, 201, res.text);
    return { cookie: sessionCookieFrom(res), body: JSON.parse(res.text) };
  }

  test('GET /merchant/login serves the login page', async () => {
    const res = await request('GET', '/merchant/login');
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('Merchant Login'));
  });

  test('GET /merchant without a session redirects to login', async () => {
    const res = await request('GET', '/merchant');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/merchant/login');
  });

  test('register succeeds and sets a merchant session cookie', async () => {
    const res = await request('POST', '/merchant/api/register', {
      name: 'Priya Sharma',
      businessName: 'Priya Store',
      email: 'priya@example.com',
      phone: '9876543210',
      password: 'correct-horse-123'
    });
    assert.equal(res.status, 201, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.merchant.businessName, 'Priya Store');
    assert.equal(body.user.email, 'priya@example.com');
    assert.ok(!res.text.includes('passwordHash'));
    assert.ok(!res.text.includes('webhook_secret'));
    const rawCookie = res.headers['set-cookie'][0];
    assert.ok(rawCookie.startsWith('paynova_merchant_session='));
    assert.ok(rawCookie.includes('HttpOnly'));
    assert.ok(rawCookie.includes('Path=/merchant'));
  });

  test('register rejects a short password and a duplicate email', async () => {
    const short = await request('POST', '/merchant/api/register', {
      name: 'Short Pass',
      businessName: 'Short Store',
      email: 'short@example.com',
      password: 'abc'
    });
    assert.equal(short.status, 400);

    const dup = await request('POST', '/merchant/api/register', {
      name: 'Priya Again',
      businessName: 'Priya Store 2',
      email: 'priya@example.com',
      password: 'correct-horse-123'
    });
    assert.equal(dup.status, 409);
  });

  test('login succeeds with the registered account; wrong password gives 401', async () => {
    const ok = await request('POST', '/merchant/api/login', {
      email: 'priya@example.com',
      password: 'correct-horse-123'
    });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).user.email, 'priya@example.com');
    sessionCookieFrom(ok);

    const wrong = await request('POST', '/merchant/api/login', {
      email: 'priya@example.com',
      password: 'wrong-password-123'
    });
    assert.equal(wrong.status, 401);
    assert.equal(JSON.parse(wrong.text).error, 'Invalid email or password.');

    const unknown = await request('POST', '/merchant/api/login', {
      email: 'nobody@example.com',
      password: 'wrong-password-123'
    });
    assert.equal(unknown.status, 401);
    assert.equal(JSON.parse(unknown.text).error, 'Invalid email or password.');
  });

  test('GET /merchant/api/me without a cookie returns 401; with a cookie returns own merchant only', async () => {
    const anon = await request('GET', '/merchant/api/me');
    assert.equal(anon.status, 401);

    const { cookie } = await registerMerchant('me');
    const me = await request('GET', '/merchant/api/me', null, cookie);
    assert.equal(me.status, 200);
    const body = JSON.parse(me.text);
    assert.equal(body.merchant.businessName, 'Test Business me');
    assert.equal(body.user.email, 'owner-me@example.com');
    assert.ok(!('webhookSecret' in body.merchant));
    assert.ok(!('passwordHash' in body.user));
  });

  test('merchant A payments and accounts are NOT visible to merchant B', async () => {
    const a = await registerMerchant('aaa');
    const b = await registerMerchant('bbb');

    paymentRepo.create({
      merchantId: a.body.merchant.id,
      orderId: 'ORDER-A-ONLY',
      amountPaise: 25000,
      currency: 'INR',
      method: 'UPI',
      status: 'INITIATED'
    });
    accountRepo.create({
      merchantId: a.body.merchant.id,
      upiId: 'aaa-only@okbank',
      payeeName: 'A Only'
    });

    const aPayments = await request('GET', '/merchant/api/payments', null, a.cookie);
    assert.equal(aPayments.status, 200);
    assert.ok(JSON.parse(aPayments.text).payments.some(p => p.orderId === 'ORDER-A-ONLY'));

    const bPayments = await request('GET', '/merchant/api/payments', null, b.cookie);
    assert.equal(bPayments.status, 200);
    assert.ok(!JSON.parse(bPayments.text).payments.some(p => p.orderId === 'ORDER-A-ONLY'));

    const bAccounts = await request('GET', '/merchant/api/accounts', null, b.cookie);
    assert.equal(bAccounts.status, 200);
    assert.ok(!JSON.parse(bAccounts.text).accounts.some(ac => ac.upiId === 'aaa-only@okbank'));

    // B cannot activate A's account either
    const aAccounts = await request('GET', '/merchant/api/accounts', null, a.cookie);
    const aAccountId = JSON.parse(aAccounts.text).accounts.find(ac => ac.upiId === 'aaa-only@okbank').id;
    const cross = await request('POST', `/merchant/api/accounts/${aAccountId}/activate`, null, b.cookie);
    assert.equal(cross.status, 404);
  });

  test('merchant can add an account and update own settings', async () => {
    const { cookie } = await registerMerchant('set');
    const added = await request('POST', '/merchant/api/accounts', {
      upiId: 'setshop@okbank',
      payeeName: 'Set Shop'
    }, cookie);
    assert.equal(added.status, 201, added.text);
    assert.equal(JSON.parse(added.text).account.upiId, 'setshop@okbank');

    const bad = await request('POST', '/merchant/api/accounts', {
      upiId: 'no-at-sign',
      payeeName: 'Bad'
    }, cookie);
    assert.equal(bad.status, 400);

    const patched = await request('PATCH', '/merchant/api/me', {
      businessName: 'Set Shop Renamed',
      webhookUrl: 'https://example.com/hook'
    }, cookie);
    assert.equal(patched.status, 200);
    assert.equal(JSON.parse(patched.text).merchant.businessName, 'Set Shop Renamed');
    assert.equal(JSON.parse(patched.text).merchant.webhookUrl, 'https://example.com/hook');

    const out = await request('POST', '/merchant/api/logout', null, cookie);
    assert.equal(out.status, 200);
    const afterLogout = await request('GET', '/merchant/api/me', null, cookie);
    assert.equal(afterLogout.status, 401);
  });
});
