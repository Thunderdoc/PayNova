import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  getSessionStoreConfig,
  snapshotSession,
  restoreSessionFiles,
  restoreWhatsAppSession,
  saveWhatsAppSession,
  deleteStoredSession,
  attachSessionPersistence,
  hasLocalCreds
} from '../services/whatsapp-session-store.js';

// Fake session files. Values are obviously fake markers, never real creds.
const FAKE_CREDS = JSON.stringify({ marker: 'fake-creds-do-not-use', key: 'abc123' });
const FAKE_CREDS_SUB = JSON.stringify({ marker: 'fake-sub-creds', key: 'def456' });
const FAKE_DB = Buffer.from('fake-sqlite-bytes-0123456789');
const FAKE_META = JSON.stringify({
  status: 'CONNECTED',
  phoneNumber: '+919999999999',
  sessionId: 'fake_session_1',
  platform: 'BerryProtocol v0.1.10'
});

function makeSessionDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-session-'));
  const paths = {
    rootDir: tmp,
    sessionPath: path.join(tmp, 'data', 'berry_auth'),
    databasePath: path.join(tmp, 'data', 'berry_store.db'),
    metaFile: path.join(tmp, 'data', 'whatsapp_session.json')
  };
  fs.mkdirSync(path.join(paths.sessionPath, 'fake_session_1'), { recursive: true });
  fs.writeFileSync(path.join(paths.sessionPath, 'creds.json'), FAKE_CREDS);
  fs.writeFileSync(path.join(paths.sessionPath, 'fake_session_1', 'creds.json'), FAKE_CREDS_SUB);
  fs.writeFileSync(paths.databasePath, FAKE_DB);
  fs.writeFileSync(`${paths.databasePath}-wal`, Buffer.from('fake-wal'));
  fs.writeFileSync(paths.metaFile, FAKE_META);
  return { tmp, paths };
}

function wipeSessionDir(paths) {
  fs.rmSync(path.join(paths.rootDir, 'data'), { recursive: true, force: true });
}

function readAll(paths) {
  const out = {};
  const collect = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else out[path.relative(paths.rootDir, full).split(path.sep).join('/')] = fs.readFileSync(full);
    }
  };
  collect(path.join(paths.rootDir, 'data'));
  return out;
}

// In-memory fake for the Cloudflare KV REST API.
function makeFakeKv() {
  const store = new Map();
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    const key = decodeURIComponent(url.split('/values/')[1]);
    if ((opts.method || 'GET') === 'PUT') {
      store.set(key, JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    if (opts.method === 'DELETE') {
      store.delete(key);
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    if (!store.has(key)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => store.get(key) };
  };
  return { store, calls, fetchImpl };
}

const ENABLED = {
  enabled: true,
  accountId: 'fake-acct',
  namespaceId: 'fake-ns',
  apiToken: 'fake-token',
  key: 'test-key'
};

test('session store is a complete no-op without KV env vars', async () => {
  const config = getSessionStoreConfig({});
  assert.equal(config.enabled, false);
  const { paths } = makeSessionDir();
  let fetchCalls = 0;
  const countingFetch = async () => { fetchCalls++; throw new Error('must not be called'); };
  assert.deepEqual(await restoreWhatsAppSession(paths, { config, fetchImpl: countingFetch }), {
    restored: false, files: [], reason: 'disabled'
  });
  assert.deepEqual(await saveWhatsAppSession(paths, { config, fetchImpl: countingFetch }), {
    saved: false, reason: 'disabled'
  });
  assert.deepEqual(await deleteStoredSession({ config, fetchImpl: countingFetch }), {
    deleted: false, reason: 'disabled'
  });
  assert.equal(fetchCalls, 0);
});

test('snapshot -> wipe -> restore round-trip reproduces files byte-identically', async () => {
  const { tmp, paths } = makeSessionDir();
  const before = readAll(paths);
  assert.ok(Object.keys(before).length >= 5);

  const snapshot = snapshotSession(paths);
  assert.equal(snapshot.version, 1);
  assert.ok(snapshot.files['data/berry_auth/creds.json']);
  assert.ok(snapshot.files['data/berry_auth/fake_session_1/creds.json']);
  assert.ok(snapshot.files['data/berry_store.db']);
  assert.ok(snapshot.files['data/whatsapp_session.json']);

  wipeSessionDir(paths);
  assert.deepEqual(readAll(paths), {});

  const restored = restoreSessionFiles(snapshot, paths);
  assert.equal(restored.length, Object.keys(snapshot.files).length);

  const after = readAll(paths);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const key of Object.keys(before)) {
    assert.ok(after[key].equals(before[key]), `file differs: ${key}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('restore never overwrites existing local credential files', async () => {
  const { tmp, paths } = makeSessionDir();
  const snapshot = snapshotSession(paths);
  // Local creds rotate after the snapshot was taken.
  const newerCreds = JSON.stringify({ marker: 'newer-local-creds' });
  fs.writeFileSync(path.join(paths.sessionPath, 'creds.json'), newerCreds);
  fs.rmSync(paths.metaFile, { force: true }); // meta missing locally

  const restored = restoreSessionFiles(snapshot, paths);
  // creds untouched, meta filled from the CONNECTED snapshot.
  assert.equal(fs.readFileSync(path.join(paths.sessionPath, 'creds.json'), 'utf8'), newerCreds);
  assert.equal(fs.readFileSync(paths.metaFile, 'utf8'), FAKE_META);
  assert.ok(restored.includes('data/whatsapp_session.json'));
  assert.ok(!restored.includes('data/berry_auth/creds.json'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('restore rejects snapshot paths escaping the data dir', async () => {
  const { tmp, paths } = makeSessionDir();
  const evil = snapshotSession(paths);
  evil.files['../evil.txt'] = Buffer.from('pwned').toString('base64');
  evil.files['data/../../evil2.txt'] = Buffer.from('pwned').toString('base64');
  const restored = restoreSessionFiles(evil, paths);
  assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')));
  assert.ok(!fs.existsSync(path.join(tmp, 'evil2.txt')));
  assert.ok(!restored.includes('../evil.txt'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('save + restore through the fake KV round-trips', async () => {
  const { tmp, paths } = makeSessionDir();
  const kv = makeFakeKv();
  const saved = await saveWhatsAppSession(paths, { config: ENABLED, fetchImpl: kv.fetchImpl });
  assert.equal(saved.saved, true);
  assert.equal(kv.store.size, 1);

  wipeSessionDir(paths);
  const result = await restoreWhatsAppSession(paths, { config: ENABLED, fetchImpl: kv.fetchImpl });
  assert.equal(result.restored, true);
  assert.equal(fs.readFileSync(path.join(paths.sessionPath, 'creds.json'), 'utf8'), FAKE_CREDS);
  assert.equal(fs.readFileSync(paths.metaFile, 'utf8'), FAKE_META);
  assert.ok(fs.readFileSync(paths.databasePath).equals(FAKE_DB));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('restore with no KV snapshot returns false and writes nothing', async () => {
  const { tmp, paths } = makeSessionDir();
  wipeSessionDir(paths);
  const kv = makeFakeKv();
  const result = await restoreWhatsAppSession(paths, { config: ENABLED, fetchImpl: kv.fetchImpl });
  assert.equal(result.restored, false);
  assert.equal(result.reason, 'no-snapshot');
  assert.deepEqual(readAll(paths), {});
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('save skips when there are no local files (never clobbers a good snapshot)', async () => {
  const { tmp, paths } = makeSessionDir();
  const kv = makeFakeKv();
  await saveWhatsAppSession(paths, { config: ENABLED, fetchImpl: kv.fetchImpl });
  const goodSnapshot = kv.store.get('test-key');
  assert.ok(goodSnapshot);

  wipeSessionDir(paths);
  const skipped = await saveWhatsAppSession(paths, { config: ENABLED, fetchImpl: kv.fetchImpl });
  assert.equal(skipped.saved, false);
  assert.equal(skipped.reason, 'empty');
  assert.deepEqual(kv.store.get('test-key'), goodSnapshot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('save never logs file contents', async () => {
  const { tmp, paths } = makeSessionDir();
  const kv = makeFakeKv();
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    await saveWhatsAppSession(paths, { config: ENABLED, fetchImpl: kv.fetchImpl });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  const joined = lines.join('\n');
  assert.ok(!joined.includes('fake-creds-do-not-use'), 'creds content leaked into logs');
  assert.ok(!joined.includes(Buffer.from(FAKE_CREDS).toString('base64')), 'base64 blob leaked into logs');
  assert.ok(joined.includes('data/berry_auth/creds.json'), 'expected file names in logs');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('attach wires ready -> save and manual logout -> KV delete', async (t) => {
  const { tmp, paths } = makeSessionDir();
  const kv = makeFakeKv();
  const service = new EventEmitter();
  Object.assign(service, paths);

  const handle = attachSessionPersistence(service, paths, {
    config: ENABLED, fetchImpl: kv.fetchImpl, debounceMs: 10, forceInTest: true
  });
  assert.ok(handle);
  t.after(() => handle.stop());

  service.emit('ready');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(kv.store.size, 1);

  // Manual logout with local creds wiped -> remote copy deleted.
  wipeSessionDir(paths);
  assert.equal(hasLocalCreds(paths), false);
  service.emit('disconnected', { reason: 'logged_out' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(kv.store.size, 0);

  // Transient disconnect must NOT delete the remote copy.
  const { paths: paths2 } = makeSessionDir();
  const kv2 = makeFakeKv();
  const service2 = new EventEmitter();
  Object.assign(service2, paths2);
  const handle2 = attachSessionPersistence(service2, paths2, {
    config: ENABLED, fetchImpl: kv2.fetchImpl, debounceMs: 10, forceInTest: true
  });
  t.after(() => handle2.stop());
  service2.emit('ready');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(kv2.store.size, 1);
  service2.emit('disconnected', { reason: 'connection lost' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(kv2.store.size, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});
