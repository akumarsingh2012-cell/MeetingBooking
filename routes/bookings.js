// routes/bookings.js
const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { auth, adminOnly } = require('../middleware/auth');

const genId = () => `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const genNId = () => `n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function t2m(t) { const [h, m] = (t || '0:0').split(':'); return +h * 60 + +m; }
function today() { return new Date().toISOString().split('T')[0]; }

// ─── Validation ────────────────────────────────────────────────────────────
function validate({ room_id, date, start_time, end_time, persons, exclude_id }) {
  const sm = t2m(start_time), em = t2m(end_time);

  if (isNaN(sm) || isNaN(em))        return 'Invalid times.';
  if (sm < 9 * 60 || em > 20 * 60)  return 'Office hours: 9 AM – 8 PM only.';
  if (sm >= em)                       return 'End must be after start.';
  if (em - sm < 15)                   return 'Minimum 15 minutes.';
  if (date < today())                 return 'Cannot book in the past.';

  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room_id);
  if (!room)          return 'Room not found.';
  if (room.blocked)   return 'Room is currently blocked.';
  if (em - sm > room.max_dur) return `Exceeds max ${room.max_dur / 60}h for this room.`;
  if (persons && +persons > room.capacity) return `Exceeds room capacity (${room.capacity}).`;

  // Conflict check:
  // Only APPROVED bookings block a slot.
  // Pending external bookings do NOT block — multiple users can request the same slot;
  // the slot gets locked only when admin approves one of them.
  let conflictQ = `
    SELECT start_time, end_time FROM bookings
    WHERE room_id = ? AND date = ? AND status = 'approved'
  `;
  const params = [room_id, date];
  if (exclude_id) { conflictQ += ' AND id != ?'; params.push(exclude_id); }

  const existing = db.prepare(conflictQ).all(...params);
  for (const b of existing) {
    if (sm < t2m(b.end_time) && em > t2m(b.start_time)) {
      return `Conflicts with an approved booking (${b.start_time}–${b.end_time}).`;
    }
  }

  return null; // all good
}

function addNotification(user_id, title, message, type = 'info') {
  db.prepare(`INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, ?)`)
    .run(genNId(), user_id, title, message, type);
}

function formatBooking(b) {
  return { ...b, food: !!b.food };
}

// ─── GET /api/bookings  ────────────────────────────────────────────────────
// Admin: all bookings; Employee: their own only
router.get('/', auth, (req, res) => {
  const { room_id, status, meeting_type, date, q } = req.query;
  let sql = `
    SELECT b.*, u.name as user_name, u.email as user_email,
           r.name as room_name, r.color as room_color, r.floor as room_floor
    FROM bookings b
    JOIN users u ON u.id = b.user_id
    JOIN rooms r ON r.id = b.room_id
    WHERE 1=1
  `;
  const params = [];

  if (req.user.role !== 'admin') {
    sql += ' AND b.user_id = ?'; params.push(req.user.id);
  }
  if (room_id)       { sql += ' AND b.room_id = ?';       params.push(room_id); }
  if (status)        { sql += ' AND b.status = ?';         params.push(status); }
  if (meeting_type)  { sql += ' AND b.meeting_type = ?';   params.push(meeting_type); }
  if (date)          { sql += ' AND b.date = ?';           params.push(date); }
  if (q) {
    sql += ' AND (b.purpose LIKE ? OR u.name LIKE ? OR u.email LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY b.date DESC, b.start_time DESC';

  res.json(db.prepare(sql).all(...params).map(formatBooking));
});

// ─── GET /api/bookings/pending-count  (admin only, for sidebar badge)
router.get('/pending-count', auth, adminOnly, (req, res) => {
  const row = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status = 'pending'").get();
  res.json({ count: row.c });
});

// ─── GET /api/bookings/:id
router.get('/:id', auth, (req, res) => {
  const b = db.prepare(`
    SELECT b.*, u.name as user_name, u.email as user_email,
           r.name as room_name, r.color as room_color, r.floor as room_floor
    FROM bookings b
    JOIN users u ON u.id = b.user_id
    JOIN rooms r ON r.id = b.room_id
    WHERE b.id = ?
  `).get(req.params.id);

  if (!b) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && b.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(formatBooking(b));
});

// ─── POST /api/bookings  ───────────────────────────────────────────────────
router.post('/', auth, (req, res) => {
  const { room_id, date, start_time, end_time, meeting_type, purpose, persons = '', food = false, veg_nonveg = '', remarks = '' } = req.body;

  if (!room_id || !date || !start_time || !end_time || !meeting_type || !purpose) {
    return res.status(400).json({ error: 'Missing required fields: room_id, date, start_time, end_time, meeting_type, purpose' });
  }
  if (meeting_type === 'external' && food && !veg_nonveg) {
    return res.status(400).json({ error: 'Food preference (veg_nonveg) required when food is requested' });
  }

  const err = validate({ room_id, date, start_time, end_time, persons });
  if (err) return res.status(422).json({ error: err });

  const id = genId();
  const status = meeting_type === 'external' ? 'pending' : 'approved';

  db.prepare(`
    INSERT INTO bookings (id, user_id, room_id, date, start_time, end_time, meeting_type, purpose, persons, food, veg_nonveg, remarks, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, room_id, date, start_time, end_time, meeting_type, purpose, persons, food ? 1 : 0, veg_nonveg, remarks, status);

  // Notify all admins
  const room = db.prepare('SELECT name FROM rooms WHERE id = ?').get(room_id);
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all();
  admins.forEach(a => addNotification(a.id, 'New Booking', `${req.user.name} booked ${room.name} on ${date}`, 'info'));

  const booking = db.prepare(`
    SELECT b.*, u.name as user_name, u.email as user_email,
           r.name as room_name, r.color as room_color, r.floor as room_floor
    FROM bookings b JOIN users u ON u.id = b.user_id JOIN rooms r ON r.id = b.room_id
    WHERE b.id = ?
  `).get(id);

  res.status(201).json(formatBooking(booking));
});

// ─── PATCH /api/bookings/:id/cancel
router.patch('/:id/cancel', auth, (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && b.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (!['approved','pending'].includes(b.status)) return res.status(400).json({ error: 'Cannot cancel this booking' });
  if (req.user.role !== 'admin' && new Date() >= new Date(`${b.date}T${b.start_time}`)) {
    return res.status(400).json({ error: 'Meeting already started.' });
  }
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  res.json({ message: 'Booking cancelled' });
});

// ─── PATCH /api/bookings/:id/approve  (admin only)
router.patch('/:id/approve', auth, adminOnly, (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.status !== 'pending') return res.status(400).json({ error: 'Booking is not pending' });

  // Approve this booking
  db.prepare("UPDATE bookings SET status = 'approved', approved_at = datetime('now') WHERE id = ?").run(req.params.id);
  addNotification(b.user_id, 'Booking Approved', `Your booking for ${b.date} has been approved.`, 'success');

  // Auto-reject all other pending bookings for the same room/date that overlap this time slot.
  // This handles the case where multiple external users requested the same slot — once one is
  // approved the slot is locked and the rest must be rejected automatically.
  const conflicting = db.prepare(`
    SELECT id, user_id FROM bookings
    WHERE room_id = ? AND date = ? AND status = 'pending' AND id != ?
  `).all(b.room_id, b.date, b.id);

  const sm = t2m(b.start_time), em = t2m(b.end_time);
  const autoRejectReason = 'Slot was taken by another approved booking for the same time.';

  conflicting.forEach(c => {
    // Only reject if time actually overlaps
    const cb = db.prepare('SELECT start_time, end_time FROM bookings WHERE id = ?').get(c.id);
    if (t2m(cb.start_time) < em && t2m(cb.end_time) > sm) {
      db.prepare("UPDATE bookings SET status = 'rejected', rejection_reason = ? WHERE id = ?")
        .run(autoRejectReason, c.id);
      addNotification(c.user_id, 'Booking Auto-Rejected',
        `Another booking was approved for the same time slot on ${b.date}. Please choose a different time.`, 'error');
    }
  });

  res.json({ message: 'Approved', auto_rejected: conflicting.length });
});

// ─── PATCH /api/bookings/:id/reject  (admin only)
router.patch('/:id/reject', auth, adminOnly, (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Rejection reason required' });

  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.status !== 'pending') return res.status(400).json({ error: 'Booking is not pending' });

  db.prepare("UPDATE bookings SET status = 'rejected', rejection_reason = ? WHERE id = ?").run(reason, req.params.id);
  addNotification(b.user_id, 'Booking Rejected', `Reason: ${reason}`, 'error');
  res.json({ message: 'Rejected' });
});

module.exports = router;
