// routes/settings.js  –  app-wide key/value settings (admin only for write)
const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/settings  (admin only)
router.get('/', auth, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  rows.forEach(r => { out[r.key] = r.value; });
  res.json(out);
});

// PUT /api/settings  (admin only) — upsert key/value pairs
router.put('/', auth, adminOnly, (req, res) => {
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const txn = db.transaction((pairs) => {
    for (const [k, v] of Object.entries(pairs)) {
      upsert.run(k, String(v));
    }
  });
  txn(req.body);
  res.json({ message: 'Settings saved' });
});

module.exports = router;
