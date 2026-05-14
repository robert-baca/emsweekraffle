const express = require('express');
const { createClient } = require('@libsql/client/web');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '4262';
const COOLDOWN_MINUTES = 15;

// ── Database client ──────────────────────────────────────────────────────────
// Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN in Vercel environment variables.
// For local dev use the same Turso credentials or set TURSO_DATABASE_URL=file:database.db

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:database.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

// ── Schema + seed ────────────────────────────────────────────────────────────

async function initDb() {
  await db.executeMultiple(`
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
    );
    CREATE TABLE IF NOT EXISTS survey_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_text TEXT NOT NULL,
      question_type TEXT NOT NULL CHECK(question_type IN ('scale','multiple_choice','open_text')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS survey_choices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
      choice_text TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS survey_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
      answer_text TEXT,
      answered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS draw_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      drawn_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const { rows } = await db.execute('SELECT COUNT(*) as cnt FROM survey_questions');
  if (rows[0].cnt) return;

  // Seed default questions
  const q1 = await db.execute({
    sql: "INSERT INTO survey_questions (question_text,question_type,sort_order) VALUES (?,?,?)",
    args: ['How satisfied are you with hospital-to-EMS communication at this facility?', 'scale', 1]
  });
  const q2 = await db.execute({
    sql: "INSERT INTO survey_questions (question_text,question_type,sort_order) VALUES (?,?,?)",
    args: ['How would you rate the patient handoff / ER transition experience?', 'multiple_choice', 2]
  });
  const q3 = await db.execute({
    sql: "INSERT INTO survey_questions (question_text,question_type,sort_order) VALUES (?,?,?)",
    args: ['What would most improve your experience with this hospital?', 'multiple_choice', 3]
  });
  const q4 = await db.execute({
    sql: "INSERT INTO survey_questions (question_text,question_type,sort_order) VALUES (?,?,?)",
    args: ['How many years have you worked in EMS?', 'multiple_choice', 4]
  });
  await db.execute({
    sql: "INSERT INTO survey_questions (question_text,question_type,sort_order) VALUES (?,?,?)",
    args: ['Any comments or suggestions?', 'open_text', 5]
  });

  const choiceSeeds = [
    [q2.lastInsertRowid, ['Excellent — smooth and efficient', 'Good — minor delays', 'Fair — room for improvement', 'Poor — significant issues']],
    [q3.lastInsertRowid, ['Faster bed assignments', 'Better radio communication', 'More staff at the door', 'Clearer documentation process', 'Other']],
    [q4.lastInsertRowid, ['Less than 1 year', '1–3 years', '4–7 years', '8–15 years', 'More than 15 years']],
  ];
  for (const [qid, choices] of choiceSeeds) {
    for (let i = 0; i < choices.length; i++) {
      await db.execute({
        sql: 'INSERT INTO survey_choices (question_id,choice_text,sort_order) VALUES (?,?,?)',
        args: [qid, choices[i], i]
      });
    }
  }
}

const ready = initDb();

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  return Math.max(0, COOLDOWN_MINUTES * 60 * 1000 - (now - last));
}

function row(rs) { return rs.rows[0]; }
function rows(rs) { return rs.rows; }
function lastId(rs) { return Number(rs.lastInsertRowid); }

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Wait for DB init before handling requests
app.use(async (req, res, next) => {
  try { await ready; next(); }
  catch (e) { res.status(500).json({ error: 'Database initialization failed' }); }
});

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Public API ────────────────────────────────────────────────────────────────

app.post('/api/check', async (req, res) => {
  const { first_name, last_name, contact } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'Name required' });

  const byName = row(await db.execute({
    sql: 'SELECT id,first_name,last_name,survey_completed,survey_skipped,entries FROM participants WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?)',
    args: [first_name.trim(), last_name.trim()]
  }));
  if (byName) return res.json({ exists: true, match: 'name', participant: byName });

  if (contact) {
    const norm = normalizeContact(contact);
    const byContact = row(await db.execute({
      sql: 'SELECT id,first_name,last_name,survey_completed,survey_skipped,entries FROM participants WHERE lower(contact)=lower(?)',
      args: [norm]
    }));
    if (byContact) return res.json({ exists: true, match: 'contact', participant: byContact });
  }

  res.json({ exists: false });
});

app.post('/api/register', async (req, res) => {
  const { first_name, last_name, contact, department, role, pin } = req.body;
  if (!first_name || !last_name || !contact || !department || !role || !pin)
    return res.status(400).json({ error: 'All fields required' });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 digits' });

  const norm = normalizeContact(contact);

  const existing = row(await db.execute({
    sql: 'SELECT id FROM participants WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?)',
    args: [first_name.trim(), last_name.trim()]
  }));
  if (existing) return res.status(409).json({ error: 'Name already registered', id: Number(existing.id) });

  const existingContact = row(await db.execute({
    sql: 'SELECT id FROM participants WHERE lower(contact)=lower(?)',
    args: [norm]
  }));
  if (existingContact) return res.status(409).json({ error: 'Contact already registered', id: Number(existingContact.id) });

  const result = await db.execute({
    sql: "INSERT INTO participants (first_name,last_name,contact,department,role,pin_hash,entries,last_entry_at) VALUES (?,?,?,?,?,?,1,datetime('now'))",
    args: [first_name.trim(), last_name.trim(), norm, department.trim(), role, hashPin(pin)]
  });

  res.json({ id: lastId(result), entries: 1, new: true });
});

app.post('/api/login', async (req, res) => {
  const { contact, pin } = req.body;
  if (!contact || !pin) return res.status(400).json({ error: 'Contact and PIN required' });

  const norm = normalizeContact(contact);
  const participant = row(await db.execute({
    sql: 'SELECT * FROM participants WHERE lower(contact)=lower(?)',
    args: [norm]
  }));

  if (!participant || participant.pin_hash !== hashPin(pin))
    return res.status(401).json({ error: 'Invalid contact or PIN' });

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

app.post('/api/entry', async (req, res) => {
  const { id, pin } = req.body;
  if (!id || !pin) return res.status(400).json({ error: 'ID and PIN required' });

  const participant = row(await db.execute({ sql: 'SELECT * FROM participants WHERE id=?', args: [id] }));
  if (!participant || participant.pin_hash !== hashPin(pin))
    return res.status(401).json({ error: 'Invalid credentials' });

  const cooldownMs = getCooldownRemaining(participant.last_entry_at);
  if (cooldownMs > 0)
    return res.status(429).json({ error: 'Cooldown active', cooldown_remaining_ms: cooldownMs });

  await db.execute({
    sql: "UPDATE participants SET entries=entries+1, last_entry_at=datetime('now') WHERE id=?",
    args: [id]
  });
  const updated = row(await db.execute({ sql: 'SELECT entries FROM participants WHERE id=?', args: [id] }));
  res.json({ entries: updated.entries, cooldown_remaining_ms: COOLDOWN_MINUTES * 60 * 1000 });
});

app.post('/api/survey', async (req, res) => {
  const { id, pin, answers } = req.body;
  if (!id || !pin) return res.status(400).json({ error: 'ID and PIN required' });

  const participant = row(await db.execute({ sql: 'SELECT * FROM participants WHERE id=?', args: [id] }));
  if (!participant || participant.pin_hash !== hashPin(pin))
    return res.status(401).json({ error: 'Invalid credentials' });
  if (participant.survey_completed || participant.survey_skipped)
    return res.status(409).json({ error: 'Survey already completed or skipped' });

  const statements = [];
  if (answers && answers.length) {
    answers.forEach(({ question_id, answer_text }) => {
      statements.push({
        sql: 'INSERT INTO survey_answers (participant_id,question_id,answer_text) VALUES (?,?,?)',
        args: [id, question_id, answer_text || null]
      });
    });
  }
  statements.push({
    sql: "UPDATE participants SET survey_completed=1, entries=entries+5, last_entry_at=datetime('now') WHERE id=?",
    args: [id]
  });
  await db.batch(statements, 'write');

  const updated = row(await db.execute({ sql: 'SELECT entries FROM participants WHERE id=?', args: [id] }));
  res.json({ entries: updated.entries, bonus: 5 });
});

app.post('/api/survey/skip', async (req, res) => {
  const { id, pin } = req.body;
  const participant = row(await db.execute({ sql: 'SELECT * FROM participants WHERE id=?', args: [id] }));
  if (!participant || participant.pin_hash !== hashPin(pin))
    return res.status(401).json({ error: 'Invalid credentials' });
  if (participant.survey_completed || participant.survey_skipped)
    return res.status(409).json({ error: 'Survey already handled' });
  await db.execute({ sql: 'UPDATE participants SET survey_skipped=1 WHERE id=?', args: [id] });
  res.json({ entries: participant.entries });
});

app.get('/api/survey/questions', async (req, res) => {
  const questions = rows(await db.execute('SELECT * FROM survey_questions WHERE active=1 ORDER BY sort_order'));
  const allChoices = rows(await db.execute('SELECT * FROM survey_choices ORDER BY question_id, sort_order'));
  questions.forEach(q => { q.choices = allChoices.filter(c => Number(c.question_id) === Number(q.id)); });
  res.json(questions);
});

// ── Admin API ─────────────────────────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ error: 'Wrong password' });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const [p, e, sc, ss] = await Promise.all([
    db.execute('SELECT COUNT(*) as n FROM participants'),
    db.execute('SELECT SUM(entries) as n FROM participants'),
    db.execute('SELECT COUNT(*) as n FROM participants WHERE survey_completed=1'),
    db.execute('SELECT COUNT(*) as n FROM participants WHERE survey_skipped=1'),
  ]);
  res.json({
    total_participants: row(p).n,
    total_entries: row(e).n || 0,
    surveys_completed: row(sc).n,
    surveys_skipped: row(ss).n,
  });
});

app.get('/api/admin/participants', requireAdmin, async (req, res) => {
  res.json(rows(await db.execute('SELECT * FROM participants ORDER BY entries DESC, registered_at ASC')));
});

app.post('/api/admin/participants', requireAdmin, async (req, res) => {
  const { first_name, last_name, contact, department, role, entries, pin } = req.body;
  if (!first_name || !last_name || !contact || !department || !role)
    return res.status(400).json({ error: 'All fields required' });
  const norm = normalizeContact(contact);
  const pinVal = pin && /^\d{4}$/.test(pin) ? pin : '0000';
  const result = await db.execute({
    sql: 'INSERT INTO participants (first_name,last_name,contact,department,role,pin_hash,entries) VALUES (?,?,?,?,?,?,?)',
    args: [first_name.trim(), last_name.trim(), norm, department.trim(), role, hashPin(pinVal), parseInt(entries) || 1]
  });
  res.json({ id: lastId(result) });
});

app.put('/api/admin/participants/:id', requireAdmin, async (req, res) => {
  const { first_name, last_name, contact, department, role, entries } = req.body;
  const existing = row(await db.execute({ sql: 'SELECT * FROM participants WHERE id=?', args: [req.params.id] }));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const norm = contact ? normalizeContact(contact) : existing.contact;
  await db.execute({
    sql: 'UPDATE participants SET first_name=?,last_name=?,contact=?,department=?,role=?,entries=? WHERE id=?',
    args: [
      first_name ?? existing.first_name,
      last_name ?? existing.last_name,
      norm,
      department ?? existing.department,
      role ?? existing.role,
      entries ?? existing.entries,
      req.params.id
    ]
  });
  res.json({ ok: true });
});

app.delete('/api/admin/participants/:id', requireAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM participants WHERE id=?', args: [req.params.id] });
  res.json({ ok: true });
});

app.get('/api/admin/export', requireAdmin, async (req, res) => {
  const list = rows(await db.execute('SELECT * FROM participants ORDER BY entries DESC'));
  const header = 'First,Last,Contact,Department,Role,Total Entries,Survey Completed,Registered At\n';
  const csv = header + list.map(r =>
    [r.first_name, r.last_name, r.contact, r.department, r.role,
     r.entries, r.survey_completed ? 'Yes' : 'No', r.registered_at]
      .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="ems-raffle-entries.csv"');
  res.send(csv);
});

// ── Admin Survey Editor ───────────────────────────────────────────────────────

app.get('/api/admin/survey/questions', requireAdmin, async (req, res) => {
  const questions = rows(await db.execute('SELECT * FROM survey_questions ORDER BY sort_order'));
  const allChoices = rows(await db.execute('SELECT * FROM survey_choices ORDER BY question_id, sort_order'));
  questions.forEach(q => { q.choices = allChoices.filter(c => Number(c.question_id) === Number(q.id)); });
  res.json(questions);
});

app.post('/api/admin/survey/questions', requireAdmin, async (req, res) => {
  const { question_text, question_type, choices } = req.body;
  if (!question_text || !question_type) return res.status(400).json({ error: 'Required fields missing' });
  const { rows: maxRows } = await db.execute('SELECT MAX(sort_order) as m FROM survey_questions');
  const maxOrder = maxRows[0].m || 0;
  const result = await db.execute({
    sql: 'INSERT INTO survey_questions (question_text,question_type,sort_order) VALUES (?,?,?)',
    args: [question_text, question_type, maxOrder + 1]
  });
  const qid = lastId(result);
  if (choices && choices.length) {
    const stmts = choices.map((text, idx) => ({
      sql: 'INSERT INTO survey_choices (question_id,choice_text,sort_order) VALUES (?,?,?)',
      args: [qid, text, idx]
    }));
    await db.batch(stmts, 'write');
  }
  res.json({ id: qid });
});

app.put('/api/admin/survey/questions/:id', requireAdmin, async (req, res) => {
  const { question_text, question_type, sort_order, active } = req.body;
  const existing = row(await db.execute({ sql: 'SELECT * FROM survey_questions WHERE id=?', args: [req.params.id] }));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await db.execute({
    sql: 'UPDATE survey_questions SET question_text=?,question_type=?,sort_order=?,active=? WHERE id=?',
    args: [
      question_text ?? existing.question_text,
      question_type ?? existing.question_type,
      sort_order ?? existing.sort_order,
      active ?? existing.active,
      req.params.id
    ]
  });
  res.json({ ok: true });
});

app.delete('/api/admin/survey/questions/:id', requireAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM survey_questions WHERE id=?', args: [req.params.id] });
  res.json({ ok: true });
});

app.post('/api/admin/survey/choices', requireAdmin, async (req, res) => {
  const { question_id, choice_text } = req.body;
  const { rows: maxRows } = await db.execute({ sql: 'SELECT MAX(sort_order) as m FROM survey_choices WHERE question_id=?', args: [question_id] });
  const maxOrder = maxRows[0].m || 0;
  const result = await db.execute({
    sql: 'INSERT INTO survey_choices (question_id,choice_text,sort_order) VALUES (?,?,?)',
    args: [question_id, choice_text, maxOrder + 1]
  });
  res.json({ id: lastId(result) });
});

app.put('/api/admin/survey/choices/:id', requireAdmin, async (req, res) => {
  await db.execute({ sql: 'UPDATE survey_choices SET choice_text=? WHERE id=?', args: [req.body.choice_text, req.params.id] });
  res.json({ ok: true });
});

app.delete('/api/admin/survey/choices/:id', requireAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM survey_choices WHERE id=?', args: [req.params.id] });
  res.json({ ok: true });
});

app.post('/api/admin/survey/reorder', requireAdmin, async (req, res) => {
  const { order } = req.body;
  await db.batch(
    order.map((id, idx) => ({ sql: 'UPDATE survey_questions SET sort_order=? WHERE id=?', args: [idx + 1, id] })),
    'write'
  );
  res.json({ ok: true });
});

// ── Admin Draw ────────────────────────────────────────────────────────────────

app.post('/api/admin/draw', requireAdmin, async (req, res) => {
  const participants = rows(await db.execute('SELECT id,first_name,last_name,department,role,contact,entries FROM participants WHERE entries > 0'));
  if (!participants.length) return res.status(400).json({ error: 'No participants' });

  const pool = [];
  participants.forEach(p => { for (let i = 0; i < p.entries; i++) pool.push(Number(p.id)); });
  const winnerId = pool[Math.floor(Math.random() * pool.length)];
  const winner = participants.find(p => Number(p.id) === winnerId);

  await db.execute({ sql: 'INSERT INTO draw_history (participant_id) VALUES (?)', args: [winner.id] });
  res.json({ id: Number(winner.id), first_name: winner.first_name, last_name: winner.last_name, department: winner.department, role: winner.role, contact: winner.contact, entries: winner.entries });
});

app.get('/api/admin/draw/history', requireAdmin, async (req, res) => {
  res.json(rows(await db.execute(`
    SELECT dh.id, dh.drawn_at, p.first_name, p.last_name, p.department, p.role, p.contact, p.entries
    FROM draw_history dh JOIN participants p ON p.id=dh.participant_id
    ORDER BY dh.drawn_at DESC
  `)));
});

// ── Static routes ─────────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// ── Start (local dev only) ────────────────────────────────────────────────────

if (require.main === module) {
  ready.then(() => {
    app.listen(PORT, () => {
      console.log(`EMS Week Raffle running on http://localhost:${PORT}`);
      console.log(`Admin panel: http://localhost:${PORT}/admin`);
    });
  }).catch(err => { console.error('DB init failed:', err); process.exit(1); });
}

module.exports = app;
