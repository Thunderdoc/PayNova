/**
 * whatsapp-session-store.js — WhatsApp (BerryProtocol) session persistence.
 *
 * PROBLEM
 * -------
 * The Berry session lives in local files (data/berry_auth/creds.json,
 * data/berry_store.db, data/whatsapp_session.json). On Render's free tier the
 * container filesystem is wiped on every deploy, so the paired WhatsApp
 * session is lost and must be re-paired with a QR scan after each deploy.
 *
 * FIX
 * ---
 * This module snapshots those files into ONE value in Cloudflare Workers KV
 * (REST API, no new npm deps — Node 20 has global fetch) and restores them
 * on boot BEFORE the Berry singleton is created. The service already
 * auto-resumes from disk (restoreSessionMeta), so restored files mean the
 * session reconnects with no QR scan.
 *
 * ACTIVATION (all from env, nothing hardcoded):
 *   WP_SESSION_STORE_ENABLED   Set to '0' or 'false' to force-disable.
 *                              (When the KV vars below are absent the module
 *                              is a complete no-op regardless of this flag.)
 *   WP_SESSION_KV_ACCOUNT_ID   Cloudflare account id.
 *   WP_SESSION_KV_NAMESPACE_ID Cloudflare Workers KV namespace id.
 *   WP_SESSION_KV_API_TOKEN    API token with Workers KV Storage:Edit on the
 *                              account (see whatsapp-session-store.md).
 *   WP_SESSION_KV_KEY          Optional KV key (default below).
 *
 * SECURITY
 * --------
 * Session credentials grant WhatsApp access. This module NEVER logs file
 * contents, keys, or base64 blobs — only file names, sizes, and
 * success/failure. Never commit session material, and never put real values
 * in docs or tests (tests use fake files + a fake fetch, no network).
 *
 * FAILURE MODE
 * ------------
 * Every public function catches its own errors and only logs a warning.
 * A failed save/restore must NEVER crash the server or break OTP sending.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../../..');

export const SESSION_STORE_KEY = 'paynova-whatsapp-session-v1';
export const SESSION_STORE_VERSION = 1;

const LOG = '[WhatsAppSessionStore]';

/** Read config from an env object (defaults to process.env). */
export function getSessionStoreConfig(env = process.env) {
  const accountId = env.WP_SESSION_KV_ACCOUNT_ID || '';
  const namespaceId = env.WP_SESSION_KV_NAMESPACE_ID || '';
  const apiToken = env.WP_SESSION_KV_API_TOKEN || '';
  const flag = String(env.WP_SESSION_STORE_ENABLED ?? '').toLowerCase();
  const disabledByFlag = flag === '0' || flag === 'false';
  const enabled = Boolean(accountId && namespaceId && apiToken) && !disabledByFlag;
  return {
    enabled,
    accountId,
    namespaceId,
    apiToken,
    key: env.WP_SESSION_KV_KEY || SESSION_STORE_KEY
  };
}

/** Default session file locations (must match WhatsAppBerryService defaults). */
export function defaultSessionPaths() {
  return {
    rootDir,
    sessionPath: path.resolve(rootDir, 'data/berry_auth'),
    databasePath: path.resolve(rootDir, 'data/berry_store.db'),
    metaFile: path.resolve(rootDir, 'data/whatsapp_session.json')
  };
}

/** Relative key (posix) for a file under rootDir, or null if outside it. */
function toRelKey(absPath, baseDir) {
  const rel = path.relative(baseDir, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Resolve a snapshot key back to disk, rejecting anything outside data/. */
function fromRelKey(relKey, baseDir) {
  const parts = String(relKey).split('/');
  if (parts.some((p) => p === '..' || p === '' || p === '.')) return null;
  const abs = path.resolve(baseDir, ...parts);
  if (!abs.startsWith(path.resolve(baseDir, 'data') + path.sep)) return null;
  return abs;
}

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Read the three session file sets into { relPath: base64 }.
 * Pure disk read — no network, no logging of contents.
 */
export function collectSessionFiles(paths) {
  const base = paths.rootDir || rootDir;
  const files = {};

  for (const abs of walkFiles(paths.sessionPath)) {
    const key = toRelKey(abs, base);
    if (key) files[key] = fs.readFileSync(abs).toString('base64');
  }
  for (const dbFile of [paths.databasePath, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`]) {
    if (dbFile && fs.existsSync(dbFile)) {
      const key = toRelKey(dbFile, base);
      if (key) files[key] = fs.readFileSync(dbFile).toString('base64');
    }
  }
  if (paths.metaFile && fs.existsSync(paths.metaFile)) {
    const key = toRelKey(paths.metaFile, base);
    if (key) files[key] = fs.readFileSync(paths.metaFile).toString('base64');
  }
  return files;
}

export function snapshotSession(paths) {
  return {
    version: SESSION_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    files: collectSessionFiles(paths)
  };
}

function snapshotStats(snapshot) {
  let bytes = 0;
  for (const b64 of Object.values(snapshot.files || {})) {
    bytes += Buffer.byteLength(b64, 'base64');
  }
  return { count: Object.keys(snapshot.files || {}).length, bytes };
}

/**
 * Write snapshot files to disk.
 * MERGE RULE (never clobber a live local session): existing credential /
 * database files are left untouched — only files missing locally are
 * written, except the meta file, which is overwritten when the snapshot
 * says CONNECTED and the local meta does not. Returns restored rel paths.
 */
export function restoreSessionFiles(snapshot, paths) {
  const base = paths.rootDir || rootDir;
  if (!snapshot || snapshot.version !== SESSION_STORE_VERSION || typeof snapshot.files !== 'object') {
    throw new Error('Invalid session snapshot');
  }
  const restored = [];
  let localMeta = null;
  try {
    if (paths.metaFile && fs.existsSync(paths.metaFile)) {
      localMeta = JSON.parse(fs.readFileSync(paths.metaFile, 'utf8'));
    }
  } catch { /* treat unreadable meta as absent */ }

  let snapshotMeta = null;
  const metaKey = paths.metaFile ? toRelKey(paths.metaFile, base) : null;
  if (metaKey && snapshot.files[metaKey]) {
    try {
      snapshotMeta = JSON.parse(Buffer.from(snapshot.files[metaKey], 'base64').toString('utf8'));
    } catch { /* keep null */ }
  }

  for (const [relKey, b64] of Object.entries(snapshot.files)) {
    const abs = fromRelKey(relKey, base);
    if (!abs) {
      console.warn(`${LOG} Skipping unsafe snapshot path: ${relKey}`);
      continue;
    }
    const isMeta = relKey === metaKey;
    if (fs.existsSync(abs)) {
      // Only the meta file may be overwritten, and only to upgrade it to a
      // CONNECTED snapshot when local meta is not CONNECTED.
      if (!isMeta) continue;
      if (snapshotMeta?.status !== 'CONNECTED' || localMeta?.status === 'CONNECTED') continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
    restored.push(relKey);
  }
  return restored;
}

/** True when any credential file exists under the auth dir. */
export function hasLocalCreds(paths) {
  if (!paths.sessionPath || !fs.existsSync(paths.sessionPath)) return false;
  if (fs.existsSync(path.join(paths.sessionPath, 'creds.json'))) return true;
  for (const entry of fs.readdirSync(paths.sessionPath, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(paths.sessionPath, entry.name, 'creds.json'))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cloudflare Workers KV REST client (global fetch, no deps)
// ---------------------------------------------------------------------------

function kvUrl(config) {
  return `https://api.cloudflare.com/client/v4/accounts/${config.accountId}` +
    `/storage/kv/namespaces/${config.namespaceId}/values/${encodeURIComponent(config.key)}`;
}

async function kvFetch(config, method, body, fetchImpl) {
  const res = await fetchImpl(kvUrl(config), {
    method,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body
  });
  return res;
}

export async function loadSnapshot(config, fetchImpl = fetch) {
  const res = await kvFetch(config, 'GET', undefined, fetchImpl);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV read failed (HTTP ${res.status})`);
  return await res.json();
}

export async function saveSnapshot(config, snapshot, fetchImpl = fetch) {
  const res = await kvFetch(config, 'PUT', JSON.stringify(snapshot), fetchImpl);
  if (!res.ok) throw new Error(`KV write failed (HTTP ${res.status})`);
}

export async function deleteSnapshot(config, fetchImpl = fetch) {
  const res = await kvFetch(config, 'DELETE', undefined, fetchImpl);
  if (!res.ok && res.status !== 404) throw new Error(`KV delete failed (HTTP ${res.status})`);
}

// ---------------------------------------------------------------------------
// High-level restore / save (never throw; warn-only on failure)
// ---------------------------------------------------------------------------

export async function restoreWhatsAppSession(paths = defaultSessionPaths(), opts = {}) {
  const config = opts.config || getSessionStoreConfig();
  if (!config.enabled) return { restored: false, files: [], reason: 'disabled' };
  try {
    const snapshot = await loadSnapshot(config, opts.fetchImpl || fetch);
    if (!snapshot) {
      console.log(`${LOG} No stored WhatsApp session found in KV — fresh pairing needed.`);
      return { restored: false, files: [], reason: 'no-snapshot' };
    }
    const files = restoreSessionFiles(snapshot, paths);
    const stats = snapshotStats(snapshot);
    console.log(`${LOG} Restored ${files.length} session file(s) from KV ` +
      `(snapshot held ${stats.count} file(s), ${stats.bytes} bytes).`);
    return { restored: files.length > 0, files };
  } catch (err) {
    console.warn(`${LOG} Restore failed, continuing with local files: ${err.message}`);
    return { restored: false, files: [], reason: 'error' };
  }
}

export async function saveWhatsAppSession(paths = defaultSessionPaths(), opts = {}) {
  const config = opts.config || getSessionStoreConfig();
  if (!config.enabled) return { saved: false, reason: 'disabled' };
  try {
    const snapshot = snapshotSession(paths);
    const stats = snapshotStats(snapshot);
    if (stats.count === 0) {
      // Never overwrite a good remote snapshot with an empty one (e.g. the
      // watcher firing while session files are being cleaned on logout).
      // Remote cleanup on manual logout is handled by the disconnected hook.
      console.log(`${LOG} No local session files to save — skipping.`);
      return { saved: false, reason: 'empty' };
    }
    await saveSnapshot(config, snapshot, opts.fetchImpl || fetch);
    const names = Object.keys(snapshot.files).join(', ');
    console.log(`${LOG} Saved ${stats.count} session file(s), ${stats.bytes} bytes: ${names}`);
    return { saved: true, files: Object.keys(snapshot.files) };
  } catch (err) {
    console.warn(`${LOG} Save failed (session continues locally): ${err.message}`);
    return { saved: false, reason: 'error' };
  }
}

export async function deleteStoredSession(opts = {}) {
  const config = opts.config || getSessionStoreConfig();
  if (!config.enabled) return { deleted: false, reason: 'disabled' };
  try {
    await deleteSnapshot(config, opts.fetchImpl || fetch);
    console.log(`${LOG} Deleted stored WhatsApp session from KV.`);
    return { deleted: true };
  } catch (err) {
    console.warn(`${LOG} Delete failed: ${err.message}`);
    return { deleted: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Wiring: attach to a live Berry service instance (sync setup, async saves)
// ---------------------------------------------------------------------------

export function attachSessionPersistence(service, paths = null, opts = {}) {
  const config = opts.config || getSessionStoreConfig();
  if (!config.enabled) return null;
  if (process.env.NODE_ENV === 'test' && !opts.forceInTest) return null;

  const sessionPaths = paths || {
    rootDir,
    sessionPath: service.sessionPath,
    databasePath: service.databasePath,
    metaFile: service.metaFile
  };
  const fetchImpl = opts.fetchImpl || fetch;
  const debounceMs = opts.debounceMs ?? 2000;

  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void saveWhatsAppSession(sessionPaths, { config, fetchImpl });
    }, debounceMs);
  };

  // (c) Debounced watcher on the auth dir. fs.watch recursive is not
  // supported on Linux, so watch the dir + each existing subdir.
  const watched = new Set();
  const watchers = [];
  const ensureWatcher = () => {
    const dirs = [sessionPaths.sessionPath];
    if (fs.existsSync(sessionPaths.sessionPath)) {
      for (const entry of fs.readdirSync(sessionPaths.sessionPath, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(sessionPaths.sessionPath, entry.name));
      }
    }
    for (const dir of dirs) {
      if (watched.has(dir) || !fs.existsSync(dir)) continue;
      try {
        const w = fs.watch(dir, { persistent: false }, () => scheduleSave());
        w.on('error', () => {});
        watchers.push(w);
        watched.add(dir);
      } catch (err) {
        console.warn(`${LOG} Watch failed for ${dir}: ${err.message}`);
      }
    }
  };
  ensureWatcher();

  // (b) Save right after a successful connection (meta file is written by
  // the service before it emits 'ready').
  const onReady = () => {
    ensureWatcher();
    scheduleSave();
  };
  service.on('ready', onReady);

  // Manual logout must not resurrect: delete the remote copy only when the
  // local credentials are actually gone (cleanSessionFiles runs before the
  // emit). Transient disconnects keep the remote copy for auto-reconnect.
  const onDisconnected = ({ reason } = {}) => {
    if ((reason === 'manual_logout' || reason === 'logged_out') && !hasLocalCreds(sessionPaths)) {
      void deleteStoredSession({ config, fetchImpl });
    }
  };
  service.on('disconnected', onDisconnected);

  // (d) Best-effort flush on SIGTERM (Render sends SIGTERM before SIGKILL;
  // the debounced watcher + 'ready' saves mean the latest creds are usually
  // already stored, so this is only a last-chance flush).
  if (!globalThis.__wpSessionSigtermHooked) {
    globalThis.__wpSessionSigtermHooked = true;
    process.once('SIGTERM', () => {
      const timeout = new Promise((resolve) => setTimeout(resolve, 8000));
      Promise.race([saveWhatsAppSession(sessionPaths, { config, fetchImpl }), timeout])
        .finally(() => process.exit(0));
    });
  }

  return {
    stop() {
      clearTimeout(saveTimer);
      for (const w of watchers) {
        try { w.close(); } catch {}
      }
      watchers.length = 0;
      watched.clear();
      service.removeListener('ready', onReady);
      service.removeListener('disconnected', onDisconnected);
    }
  };
}
