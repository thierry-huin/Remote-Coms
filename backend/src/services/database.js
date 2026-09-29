const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'winus-video.db');

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── SuperAdmin reset on startup ──
const SUPERADMIN_USER = 'Winus';
const SUPERADMIN_PASS = 'Winus2026';

(function resetSuperAdmin() {
  const hash = bcrypt.hashSync(SUPERADMIN_PASS, 10);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(SUPERADMIN_USER);
  if (existing) {
    db.prepare('UPDATE users SET password = ?, role = ? WHERE username = ?')
      .run(hash, 'superadmin', SUPERADMIN_USER);
  } else {
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
      .run(SUPERADMIN_USER, hash, 'superadmin');
  }
  console.log('[DB] SuperAdmin "Winus" reset');
})();

// Ensure default admin exists (from .env, for backwards compat)
(function ensureEnvAdmin() {
  const envUser = process.env.ADMIN_USER || 'admin';
  const envPass = process.env.ADMIN_PASS || 'admin';
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(envUser);
  if (!existing) {
    const hash = bcrypt.hashSync(envPass, 10);
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
      .run(envUser, hash, 'admin');
    console.log(`[DB] Default admin "${envUser}" created`);
  }
})();

// ── User operations ──

function authenticate(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password)) return null;
  return { id: user.id, username: user.username, role: user.role };
}

function getUsers() {
  return db.prepare(
    'SELECT id, username, role, created_at FROM users WHERE username != ? ORDER BY id'
  ).all(SUPERADMIN_USER);
}

function getUserById(id) {
  return db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id);
}

function createUser(username, password, role) {
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
    .run(username, hash, role || 'viewer');
  return getUserById(info.lastInsertRowid);
}

function updateUser(id, { username, password, role }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return null;
  if (user.username === SUPERADMIN_USER) return null; // protect superadmin

  if (username) db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id);
  }
  if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  return getUserById(id);
}

function deleteUser(id) {
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
  if (!user || user.username === SUPERADMIN_USER) return false;
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return true;
}

module.exports = {
  authenticate,
  getUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  SUPERADMIN_USER,
};
