// db/database.js  –  SQLite schema & singleton connection
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || './data/mrb.sqlite';

// Ensure the data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── SCHEMA ────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    password    TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'employee',
    active      INTEGER NOT NULL DEFAULT 1,
    phone       TEXT DEFAULT '',
    dept        TEXT DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    capacity    INTEGER NOT NULL DEFAULT 10,
    color       TEXT NOT NULL DEFAULT '#3d6ce7',
    blocked     INTEGER NOT NULL DEFAULT 0,
    max_dur     INTEGER NOT NULL DEFAULT 240,
    floor       TEXT DEFAULT '',
    amenities   TEXT DEFAULT '[]',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    room_id       TEXT NOT NULL REFERENCES rooms(id),
    date          TEXT NOT NULL,
    start_time    TEXT NOT NULL,
    end_time      TEXT NOT NULL,
    meeting_type  TEXT NOT NULL DEFAULT 'internal',
    purpose       TEXT NOT NULL,
    persons       TEXT DEFAULT '',
    food          INTEGER NOT NULL DEFAULT 0,
    veg_nonveg    TEXT DEFAULT '',
    remarks       TEXT DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'approved',
    rejection_reason TEXT DEFAULT '',
    approved_at   TEXT DEFAULT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    title       TEXT NOT NULL,
    message     TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'info',
    is_read     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL DEFAULT ''
  );
`);

// ─── SEED ──────────────────────────────────────────────────────────────────
function seed() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@company.com';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);

  if (!existing) {
    const { v4: uuidv4 } = require('crypto');
    const id = `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin@123', 10);

    db.prepare(`
      INSERT INTO users (id, name, email, password, role)
      VALUES (?, ?, ?, ?, 'admin')
    `).run(id, process.env.ADMIN_NAME || 'Admin', adminEmail, hash);

    console.log(`✅ Admin seeded: ${adminEmail}`);
  }

  // Seed default rooms if none exist
  const roomCount = db.prepare('SELECT COUNT(*) as c FROM rooms').get().c;
  if (roomCount === 0) {
    const rooms = [
      { name: 'Conference Room', cap: 20, color: '#3d6ce7', max_dur: 480, floor: '2nd Floor', amen: ['Projector','Video Call','Whiteboard'] },
      { name: 'Meeting Room 1',  cap: 10, color: '#16a34a', max_dur: 240, floor: '1st Floor', amen: ['TV Screen','Whiteboard'] },
      { name: 'Meeting Room 2',  cap: 8,  color: '#7c3aed', max_dur: 240, floor: '1st Floor', amen: ['TV Screen'] },
      { name: 'Board Room',      cap: 15, color: '#dc2626', max_dur: 480, floor: '3rd Floor', amen: ['Projector','Video Call','Catering'] },
    ];
    const ins = db.prepare(`INSERT INTO rooms (id, name, capacity, color, max_dur, floor, amenities) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    rooms.forEach(r => {
      const id = `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      ins.run(id, r.name, r.cap, r.color, r.max_dur, r.floor, JSON.stringify(r.amen));
    });
    console.log('✅ Default rooms seeded');
  }
}

seed();

module.exports = db;
