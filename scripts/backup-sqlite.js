/**
 * scripts/backup-sqlite.js
 * Automated SQLite WAL Hot Backup Engine with Zero-Downtime.
 *
 * Runs an online snapshot copy of youpi_pg.sqlite into data/backups/
 * with timestamping and automatic retention of the last 14 days of backups.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.resolve(__dirname, '../data');
const backupDir = path.join(dataDir, 'backups');
const sourceDb = path.join(dataDir, 'youpi_pg.sqlite');

if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

async function performHotBackup() {
  if (!fs.existsSync(sourceDb)) {
    console.log(`[Backup Engine] Source database not found at ${sourceDb}, skipping.`);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetFile = path.join(backupDir, `backup-paynova-${timestamp}.sqlite`);

  console.log(`[Backup Engine] Starting zero-downtime hot backup of PayNova database...`);
  const start = Date.now();

  try {
    // Checkpoint WAL before copying so the snapshot is self-contained and
    // does not depend on a separately copied, concurrently changing -wal file.
    const db = new DatabaseSync(sourceDb);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA wal_checkpoint(TRUNCATE);');
    db.close();

    // Perform copy after the checkpoint.
    fs.copyFileSync(sourceDb, targetFile);

    const stat = fs.statSync(targetFile);
    const duration = Date.now() - start;
    console.log(`[Backup Engine] ✅ Backup saved to ${path.basename(targetFile)} (${(stat.size / 1024).toFixed(1)} KB in ${duration}ms)`);

    // Retention policy: Keep the last 14 backups, remove older
    const allBackups = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('backup-paynova-') && f.endsWith('.sqlite'))
      .sort();

    if (allBackups.length > 14) {
      const toDelete = allBackups.slice(0, allBackups.length - 14);
      for (const oldFile of toDelete) {
        try {
          fs.unlinkSync(path.join(backupDir, oldFile));
          console.log(`[Backup Engine] Pruned aged backup: ${oldFile}`);
        } catch {}
      }
    }
  } catch (err) {
    console.error(`[Backup Engine] ❌ Backup failed:`, err.message);
  }
}

performHotBackup();

const intervalMs = Number(process.env.SQLITE_BACKUP_INTERVAL_MS || 0);
if (intervalMs >= 60_000) {
  setInterval(() => performHotBackup().catch(() => {}), intervalMs).unref();
  console.log(`[Backup Engine] Scheduled backups every ${Math.round(intervalMs / 60000)} minute(s).`);
}
