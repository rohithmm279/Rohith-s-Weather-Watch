'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'weather.db');
const db = new DatabaseSync(DB_PATH);

// Optimize SQLite for concurrent read/write
db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);
db.exec(`PRAGMA synchronous = NORMAL`);

// ---------------------------------------------------------------------------
// Schema — email is the primary contact identity (no phone dependency)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    email           TEXT    UNIQUE NOT NULL,
    city            TEXT    NOT NULL,
    city_normalized TEXT    NOT NULL,
    alert_rain      INTEGER NOT NULL DEFAULT 1,
    alert_heat      INTEGER NOT NULL DEFAULT 1,
    alert_wind      INTEGER NOT NULL DEFAULT 1,
    alert_thunder   INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS alert_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    risk_type       TEXT    NOT NULL,
    city_normalized TEXT    NOT NULL,
    severity        TEXT    NOT NULL,
    forecast_time   TEXT,
    alerted_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_users_city  ON users(city_normalized);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_alert_history_lookup ON alert_history(user_id, risk_type, city_normalized);
`);

// Drop legacy phone column if present (permanently removes SMS/WhatsApp phone dependency)
try {
  const cols = db.prepare('PRAGMA table_info(users)').all();
  if (cols.some(c => c.name === 'phone')) {
    db.exec('ALTER TABLE users DROP COLUMN phone');
    console.log('[DB] Permanently dropped legacy phone column from users table.');
  }
} catch (err) {
  // Gracefully continue if already removed
}

// ---------------------------------------------------------------------------
// Migration: add snooze_until column (no-op if already exists)
// ---------------------------------------------------------------------------
try {
  const cols = db.prepare('PRAGMA table_info(users)').all();
  if (!cols.find(c => c.name === 'snooze_until')) {
    db.exec(`ALTER TABLE users ADD COLUMN snooze_until TEXT DEFAULT NULL`);
    console.log('[DB] Added snooze_until column to users table.');
  }
} catch (err) {
  console.error('[DB] snooze_until migration error:', err.message);
}

// ---------------------------------------------------------------------------
// Migration: ensure alert_history has ON DELETE CASCADE
// ---------------------------------------------------------------------------
try {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='alert_history'").get();
  if (row && row.sql && !row.sql.includes('ON DELETE CASCADE')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      CREATE TABLE alert_history_mig (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL,
        risk_type       TEXT    NOT NULL,
        city_normalized TEXT    NOT NULL,
        severity        TEXT    NOT NULL,
        forecast_time   TEXT,
        alerted_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT INTO alert_history_mig SELECT * FROM alert_history;
      DROP TABLE alert_history;
      ALTER TABLE alert_history_mig RENAME TO alert_history;
      CREATE INDEX IF NOT EXISTS idx_alert_history_lookup ON alert_history(user_id, risk_type, city_normalized);
    `);
    db.exec('PRAGMA foreign_keys = ON');
    console.log('[DB] Migrated alert_history to support ON DELETE CASCADE.');
  }
} catch (err) {
  console.error('[DB] alert_history cascade migration error:', err.message);
  try { db.exec('PRAGMA foreign_keys = ON'); } catch (_) {}
}

// ---------------------------------------------------------------------------
// System Settings Table (key-value store for app state e.g. pause/resume)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS system_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.getSetting = function (key, defaultValue = null) {
  try {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  } catch (err) {
    console.error(`[DB] Failed to get setting "${key}":`, err.message);
    return defaultValue;
  }
};

db.setSetting = function (key, value) {
  try {
    db.prepare(`
      INSERT OR REPLACE INTO system_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).run(key, String(value));
    return true;
  } catch (err) {
    console.error(`[DB] Failed to set setting "${key}":`, err.message);
    return false;
  }
};

module.exports = db;

