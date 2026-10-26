import crypto from 'node:crypto';

export class MerchantUserRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Creates a merchant portal user. `passwordHash` must already be a
   * scrypt hash produced by the auth layer — never a plaintext password.
   * The returned object never includes the password hash.
   */
  create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.execute(`
      INSERT INTO merchant_users (id, merchant_id, name, email, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      data.merchantId,
      data.name || null,
      data.email,
      data.passwordHash,
      now,
      now
    ]);

    return this.findById(id);
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM merchant_users WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Public lookup — never returns the password hash.
   */
  findByEmail(email) {
    if (!email) return null;
    const row = this.db.queryOne(
      'SELECT * FROM merchant_users WHERE email = ?',
      [String(email).trim().toLowerCase()]
    );
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Auth-only lookup. Includes `passwordHash` for credential verification
   * and must never be serialized into an API response.
   */
  findByEmailForAuth(email) {
    if (!email) return null;
    const row = this.db.queryOne(
      'SELECT * FROM merchant_users WHERE email = ?',
      [String(email).trim().toLowerCase()]
    );
    if (!row) return null;
    return { ...this.mapRow(row), passwordHash: row.password_hash };
  }

  /**
   * Creates a session row storing ONLY the sha256 hash of the raw token.
   */
  createSession(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.execute(`
      INSERT INTO merchant_sessions (id, merchant_user_id, token_hash, expires_at, is_active, ip_address, user_agent, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    `, [
      id,
      data.merchantUserId,
      data.tokenHash,
      data.expiresAt instanceof Date ? data.expiresAt.toISOString() : data.expiresAt,
      data.ipAddress || null,
      data.userAgent || null,
      now,
      now
    ]);

    return this.findSessionById(id);
  }

  findSessionById(id) {
    const row = this.db.queryOne('SELECT * FROM merchant_sessions WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapSessionRow(row);
  }

  /**
   * Validates a session by its token hash. Returns null for unknown,
   * revoked, or expired sessions (expired rows are marked inactive).
   */
  findByTokenHash(tokenHash) {
    if (!tokenHash) return null;
    const row = this.db.queryOne(
      'SELECT * FROM merchant_sessions WHERE token_hash = ? AND is_active = 1',
      [tokenHash]
    );
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      try {
        this.db.execute('UPDATE merchant_sessions SET is_active = 0, updated_at = ? WHERE id = ?', [
          new Date().toISOString(),
          row.id
        ]);
      } catch {}
      return null;
    }
    return this.mapSessionRow(row);
  }

  revokeSessionByTokenHash(tokenHash) {
    if (!tokenHash) return false;
    this.db.execute(
      'UPDATE merchant_sessions SET is_active = 0, updated_at = ? WHERE token_hash = ?',
      [new Date().toISOString(), tokenHash]
    );
    return true;
  }

  revokeAllForUser(merchantUserId) {
    if (!merchantUserId) return;
    this.db.execute(
      'UPDATE merchant_sessions SET is_active = 0, updated_at = ? WHERE merchant_user_id = ?',
      [new Date().toISOString(), merchantUserId]
    );
  }

  mapRow(row) {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      name: row.name,
      email: row.email,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  mapSessionRow(row) {
    return {
      id: row.id,
      merchantUserId: row.merchant_user_id,
      expiresAt: new Date(row.expires_at),
      isActive: Boolean(row.is_active),
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}
