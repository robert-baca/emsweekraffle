const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '4262';
const COOLDOWN_MINUTES = 15;

// ── Database setup ──────────────────────────────────────────────────────────

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'database.db');
const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    contact TEXT NOT NULL,
    department TEXT NOT NULL,
    role TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    entries INTEGER NOT NULL DEFAULT 1,
    survey_completed INTEGER NOT NULL DEFAULT 0,
    survey_skipped INTEGER NOT NULL DEFAULT 0,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_entry_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS survey_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_text TEXT NOT NULL,
    question_type TEXT NOT NULL CHECK(question_type IN ('scale', 'multiple_choice', 'open_text')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS survey_choices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
    choice_text TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS survey_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
    answer_text TEXT,
    answered_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS draw_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    drawn_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Seed default survey questions if none exist
const questionCount = db.prepare('SELECT COUNT(*) as cnt FROM survey_questions').get().cnt;
if (!questionCount) {
  const insertQ = db.prepare(
    'INSERT INTO survey_questions (question_text, question_type, sort_order) VALUES (?, ?, ?)'
  );
  const insertC = db.prepare(
    'INSERT INTO survey_choices (question_id, choice_text, sort_order) VALUES (?, ?, ?)'
  );

  const q1 = insertQ.run('How satisfied are you with hospital-to-EMS communication at this facility?', 'scale', 1);
  const q2 = insertQ.run('How would you rate the patient handoff / ER transition experience?', 'multiple_choice', 2);
  const q3 = insertQ.run('What would most improve your experience with this hospital?', 'multiple_choice', 3);
  const q4 = insertQ.run('How many years have you worked in EMS?', 'multiple_choice', 4);
  const q5 = insertQ.run('Any comments or suggestions?', 'open_text', 5);

  [
    [q2.lastInsertRowid, ['Excellent — smooth and efficient', 'Good — minor delays', 'Fair — room for improvement', 'Poor — significant issues']],
    [q3.lastInsertRowid, ['Faster bed assignments', 'Better radio communication', 'More staff at the door', 'Clearer documentation process', 'Other']],
    [q4.lastInsertRowid, ['Less than 1 year', '1–3 years', '4–7 years', '8–15 years', 'More than 15 years']],
  ].forEach(([qid, choices]) => {
    choices.forEach((text, idx) => insertC.run(qid, text, idx));
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function hashPin(pin) {
  return crypto.createHash('sha256').update(pin + 'ems2026salt').digest('hex');
}

function normalizeContact(contact) {
  const digits = contact.replace(/\D/g, '');
  return digits.length >= 7 ? digits : contact.toLowerCase().trim();
}

function getCooldownRemaining(lastEntryAt) {
  const last = new Date(lastEntryAt + 'Z');
  const now = new Date();
  const diffMs = now - last;
  const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;
  return Math.max(0, cooldownMs - diffMs);
}

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  const auth = req.headers['x-admin-password'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Public API ───────────────────────────────────────────────────────────────

app.post('/api/check', (req, res) => {
  const { first_name, last_name, contact } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'Name required' });

  const byName = db.prepare(
    'SELECT id, first_name, last_name, survey_completed, survey_skipped, entries FROM participants WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?)'
  ).get(first_name.trim(), last_name.trim());

  if (byName) return res.json({ exists: true, match: 'name', participant: byName });

  if (contact) {
    const norm = normalizeContact(contact);
    const byContact = db.prepare(
      'SELECT id, first_name, last_name, survey_completed, survey_skipped, entries FROM participants WHERE lower(contact)=lower(?)'
    ).get(norm);
    if (byContact) return res.json({ exists: true, match: 'contact', participant: byContact });
  }

  res.json({ exists: false });
});

app.post('/api/register', (req, res) => {
  const { first_name, last_name, contact, department, role, pin } = req.body;
  if (!first_name || !last_name || !contact || !department || !role || !pin) {
    return res.status(400).json({ error: 'All fields required' });
  }
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 digits' });

  const norm = normalizeContact(contact);

  const existing = db.prepare(
    'SELECT id FROM participants WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?)'
  ).get(first_name.trim(), last_name.trim());
  if (existing) return res.status(409).json({ error: 'Name already registered', id: Number(existing.id) });

  const existingContact = db.prepare(
    'SELECT id FROM participants WHERE lower(contact)=lower(?)'
  ).get(norm);
  if (existingContact) return res.status(409).json({ error: 'Contact already registered', id: Number(existingContact.id) });

  const result = db.prepare(`
    INSERT INTO participants (first_name, last_name, contact, department, role, pin_hash, entries, last_entry_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))
  `).run(first_name.trim(), last_name.trim(), norm, department.trim(), role, hashPin(pin));

  res.json({ id: Number(result.lastInsertRowid), entries: 1, new: true });
});

app.post('/api/login', (req, res) => {
  const { contact, pin } = req.body;
  if (!contact || !pin) return res.status(400).json({ error: 'Contact and PIN required' });

  const norm = normalizeContact(contact);
  const participant = db.prepare(
    'SELECT * FROM participants WHERE lower(contact)=lower(?)'
  ).get(norm);

  if (!participant || participant.pin_hash !== hashPin(pin)) {
    return res.status(401).json({ error: 'Invalid contact or PIN' });
  }

  const cooldownMs = getCooldownRemaining(participant.last_entry_at);
  res.json({
    id: Number(participant.id),
    first_name: participant.first_name,
    entries: participant.entries,
    survey_completed: participant.survey_completed,
    survey_skipped: participant.survey_skipped,
    cooldown_remaining_ms: cooldownMs
  });
});

app.post('/api/entry', (req, res) => {
  const { id, pin } = req.body;
  if (!id || !pin) return res.status(400).json({ error: 'ID and PIN required' });

  const participant = db.prepare('SELECT * FROM participants WHERE id=?').get(id);
  if (!participant || participant.pin_hash !== hashPin(pin)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const cooldownMs = getCooldownRemaining(participant.last_entry_at);
  if (cooldownMs > 0) {
    return res.status(429).json({ error: 'Cooldown active', cooldown_remaining_ms: cooldownMs });
  }

  db.prepare("UPDATE participants SET entries=entries+1, last_entry_at=datetime('now') WHERE id=?").run(id);
  const updated = db.prepare('SELECT entries FROM participants WHERE id=?').get(id);
  res.json({ entries: updated.entries, cooldown_remaining_ms: COOLDOWN_MINUTES * 60 * 1000 });
});

app.post('/api/survey', (req, res) => {
  const { id, pin, answers } = req.body;
  if (!id || !pin) return res.status(400).json({ error: 'ID and PIN required' });

  const participant = db.prepare('SELECT * FROM participants WHERE id=?').get(id);
  if (!participant || participant.pin_hash !== hashPin(pin)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (participant.survey_completed || participant.survey_skipped) {
    return res.status(409).json({ error: 'Survey already completed or skipped' });
  }

  const insertAnswer = db.prepare(
    'INSERT INTO survey_answers (participant_id, question_id, answer_text) VALUES (?, ?, ?)'
  );

  db.exec('BEGIN');
  try {
    if (answers && answers.length) {
      answers.forEach(({ question_id, answer_text }) => {
        insertAnswer.run(id, question_id, answer_text || null);
      });
    }
    db.prepare("UPDATE participants SET survey_completed=1, entries=entries+5, last_entry_at=datetime('now') WHERE id=?").run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'Survey submission failed' });
  }

  const updated = db.prepare('SELECT entries FROM participants WHERE id=?').get(id);
  res.json({ entries: updated.entries, bonus: 5 });
});

app.post('/api/survey/skip', (req, res) => {
  const { id, pin } = req.body;
  const participant = db.prepare('SELECT * FROM participants WHERE id=?').get(id);
  if (!participant || participant.pin_hash !== hashPin(pin)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (participant.survey_completed || participant.survey_skipped) {
    return res.status(409).json({ error: 'Survey already handled' });
  }
  db.prepare('UPDATE participants SET survey_skipped=1 WHERE id=?').run(id);
  res.json({ entries: participant.entries });
});

app.get('/api/survey/questions', (req, res) => {
  const questions = db.prepare(
    'SELECT * FROM survey_questions WHERE active=1 ORDER BY sort_order'
  ).all();
  const choices = db.prepare(
    'SELECT * FROM survey_choices ORDER BY question_id, sort_order'
  ).all();
  questions.forEach(q => {
    q.choices = choices.filter(c => c.question_id === q.id);
  });
  res.json(questions);
});

// ── Admin API ────────────────────────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ error: 'Wrong password' });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const total_participants = db.prepare('SELECT COUNT(*) as n FROM participants').get().n;
  const total_entries = db.prepare('SELECT SUM(entries) as n FROM participants').get().n || 0;
  const surveys_completed = db.prepare('SELECT COUNT(*) as n FROM participants WHERE survey_completed=1').get().n;
  const surveys_skipped = db.prepare('SELECT COUNT(*) as n FROM participants WHERE survey_skipped=1').get().n;
  res.json({ total_participants, total_entries, surveys_completed, surveys_skipped });
});

app.get('/api/admin/participants', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM participants ORDER BY entries DESC, registered_at ASC').all();
  res.json(rows);
});

app.post('/api/admin/participants', requireAdmin, (req, res) => {
  const { first_name, last_name, contact, department, role, entries, pin } = req.body;
  if (!first_name || !last_name || !contact || !department || !role) {
    return res.status(400).json({ error: 'All fields required' });
  }
  const norm = normalizeContact(contact);
  const pinVal = pin && /^\d{4}$/.test(pin) ? pin : '0000';
  const result = db.prepare(`
    INSERT INTO participants (first_name, last_name, contact, department, role, pin_hash, entries)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(first_name.trim(), last_name.trim(), norm, department.trim(), role, hashPin(pinVal), parseInt(entries) || 1);
  res.json({ id: Number(result.lastInsertRowid) });
});

app.put('/api/admin/participants/:id', requireAdmin, (req, res) => {
  const { first_name, last_name, contact, department, role, entries } = req.body;
  const existing = db.prepare('SELECT * FROM participants WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const norm = contact ? normalizeContact(contact) : existing.contact;
  db.prepare(`
    UPDATE participants SET first_name=?, last_name=?, contact=?, department=?, role=?, entries=? WHERE id=?
  `).run(
    first_name ?? existing.first_name,
    last_name ?? existing.last_name,
    norm,
    department ?? existing.department,
    role ?? existing.role,
    entries ?? existing.entries,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/admin/participants/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM participants WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM participants ORDER BY entries DESC').all();
  const header = 'First,Last,Contact,Department,Role,Total Entries,Survey Completed,Registered At\n';
  const csv = header + rows.map(r =>
    [r.first_name, r.last_name, r.contact, r.department, r.role,
     r.entries, r.survey_completed ? 'Yes' : 'No', r.registered_at]
      .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="ems-raffle-entries.csv"');
  res.send(csv);
});

// ── Admin Survey Editor ──────────────────────────────────────────────────────

app.get('/api/admin/survey/questions', requireAdmin, (req, res) => {
  const questions = db.prepare('SELECT * FROM survey_questions ORDER BY sort_order').all();
  const choices = db.prepare('SELECT * FROM survey_choices ORDER BY question_id, sort_order').all();
  questions.forEach(q => { q.choices = choices.filter(c => c.question_id === q.id); });
  res.json(questions);
});

app.post('/api/admin/survey/questions', requireAdmin, (req, res) => {
  const { question_text, question_type, choices } = req.body;
  if (!question_text || !question_type) return res.status(400).json({ error: 'Required fields missing' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM survey_questions').get().m || 0;
  const result = db.prepare(
    'INSERT INTO survey_questions (question_text, question_type, sort_order) VALUES (?, ?, ?)'
  ).run(question_text, question_type, maxOrder + 1);
  const qid = Number(result.lastInsertRowid);
  if (choices && choices.length) {
    const ins = db.prepare('INSERT INTO survey_choices (question_id, choice_text, sort_order) VALUES (?, ?, ?)');
    choices.forEach((text, idx) => ins.run(qid, text, idx));
  }
  res.json({ id: qid });
});

app.put('/api/admin/survey/questions/:id', requireAdmin, (req, res) => {
  const { question_text, question_type, sort_order, active } = req.body;
  const existing = db.prepare('SELECT * FROM survey_questions WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE survey_questions SET question_text=?, question_type=?, sort_order=?, active=? WHERE id=?`).run(
    question_text ?? existing.question_text,
    question_type ?? existing.question_type,
    sort_order ?? existing.sort_order,
    active ?? existing.active,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/admin/survey/questions/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM survey_questions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/survey/choices', requireAdmin, (req, res) => {
  const { question_id, choice_text } = req.body;
  const row = db.prepare('SELECT MAX(sort_order) as m FROM survey_choices WHERE question_id=?').get(question_id);
  const maxOrder = row ? (row.m || 0) : 0;
  const result = db.prepare('INSERT INTO survey_choices (question_id, choice_text, sort_order) VALUES (?, ?, ?)').run(question_id, choice_text, maxOrder + 1);
  res.json({ id: Number(result.lastInsertRowid) });
});

app.put('/api/admin/survey/choices/:id', requireAdmin, (req, res) => {
  const { choice_text } = req.body;
  db.prepare('UPDATE survey_choices SET choice_text=? WHERE id=?').run(choice_text, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/survey/choices/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM survey_choices WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/survey/reorder', requireAdmin, (req, res) => {
  const { order } = req.body;
  const update = db.prepare('UPDATE survey_questions SET sort_order=? WHERE id=?');
  db.exec('BEGIN');
  try {
    order.forEach((id, idx) => update.run(idx + 1, id));
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'Reorder failed' });
  }
  res.json({ ok: true });
});

// ── Admin Draw ───────────────────────────────────────────────────────────────

app.post('/api/admin/draw', requireAdmin, (req, res) => {
  const participants = db.prepare('SELECT id, first_name, last_name, department, role, contact, entries FROM participants WHERE entries > 0').all();
  if (!participants.length) return res.status(400).json({ error: 'No participants' });

  // Weighted random selection
  const pool = [];
  participants.forEach(p => {
    for (let i = 0; i < p.entries; i++) pool.push(Number(p.id));
  });
  const winnerId = pool[Math.floor(Math.random() * pool.length)];
  const winner = participants.find(p => Number(p.id) === winnerId);

  db.prepare('INSERT INTO draw_history (participant_id) VALUES (?)').run(winner.id);
  res.json({
    id: Number(winner.id),
    first_name: winner.first_name,
    last_name: winner.last_name,
    department: winner.department,
    role: winner.role,
    contact: winner.contact,
    entries: winner.entries
  });
});

app.get('/api/admin/draw/history', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT dh.id, dh.drawn_at, p.first_name, p.last_name, p.department, p.role, p.contact, p.entries
    FROM draw_history dh
    JOIN participants p ON p.id = dh.participant_id
    ORDER BY dh.drawn_at DESC
  `).all();
  res.json(rows);
});

// ── Admin panel route ─────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`EMS Week Raffle running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});
