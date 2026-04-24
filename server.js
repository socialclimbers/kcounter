const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE-THIS-IN-PRODUCTION-use-a-long-random-string';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'calories.db');
const USER_TIMEZONE = process.env.USER_TIMEZONE || 'Australia/Brisbane';

// Returns YYYY-MM-DD in the configured user timezone.
// This prevents date boundaries shifting based on the server's UTC clock.
function localDateStr(offsetDays = 0) {
  const d = new Date();
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('en-CA', { timeZone: USER_TIMEZONE }); // en-CA gives YYYY-MM-DD
}

// ─── Database Setup ───────────────────────────────────────────────────────────

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    calorie_target INTEGER DEFAULT 2000,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS food_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    date       TEXT    NOT NULL,
    food_name  TEXT    NOT NULL,
    calories   INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_entries_user_date
    ON food_entries(user_id, date);
`);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));

app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:"
  );
  next();
});

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts — please try again later.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests.' },
});

app.use('/api/auth', authLimiter);
app.use('/api',      apiLimiter);

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session — please sign in again.' });
  }
}

// ─── Validation Helpers ───────────────────────────────────────────────────────

const validateUsername = (u) => typeof u === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(u);
const validatePassword  = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 100;
const validateCalories  = (c) => Number.isInteger(c) && c >= 0 && c <= 50000;
const validateDate      = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {};

  if (!validateUsername(username))
    return res.status(400).json({ error: 'Username must be 3–20 characters (letters, numbers, underscores only).' });
  if (!validatePassword(password))
    return res.status(400).json({ error: 'Password must be 8–100 characters.' });

  try {
    const hash   = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    const token  = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, username, calorie_target: 2000 });
  } catch (e) {
    if (e.message.includes('UNIQUE'))
      return res.status(409).json({ error: 'That username is already taken.' });
    console.error(e);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid username or password.' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username, calorie_target: user.calorie_target });
});

// ─── User Routes ──────────────────────────────────────────────────────────────

app.get('/api/user', authenticate, (req, res) => {
  const user = db.prepare(
    'SELECT id, username, calorie_target, created_at FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json(user);
});

app.put('/api/user/target', authenticate, (req, res) => {
  const { calorie_target } = req.body || {};
  if (!validateCalories(calorie_target) || calorie_target < 100)
    return res.status(400).json({ error: 'Target must be between 100 and 50,000 kcal.' });

  db.prepare('UPDATE users SET calorie_target = ? WHERE id = ?').run(calorie_target, req.user.id);
  res.json({ success: true, calorie_target });
});

// ─── Food Entry Routes ────────────────────────────────────────────────────────

app.get('/api/entries', authenticate, (req, res) => {
  const { date } = req.query;

  if (date) {
    if (!validateDate(date))
      return res.status(400).json({ error: 'Invalid date format (expected YYYY-MM-DD).' });
    const rows = db.prepare(
      'SELECT * FROM food_entries WHERE user_id = ? AND date = ? ORDER BY created_at DESC'
    ).all(req.user.id, date);
    return res.json(rows);
  }

  // Default: last 30 days (computed in user's local timezone)
  const fromDate = localDateStr(-29);

  const rows = db.prepare(
    'SELECT * FROM food_entries WHERE user_id = ? AND date >= ? ORDER BY date DESC, created_at DESC'
  ).all(req.user.id, fromDate);
  res.json(rows);
});

app.post('/api/entries', authenticate, (req, res) => {
  const { food_name, calories, date } = req.body || {};

  if (!food_name || typeof food_name !== 'string' || !food_name.trim())
    return res.status(400).json({ error: 'Food name is required.' });
  if (!validateCalories(calories))
    return res.status(400).json({ error: 'Calories must be a number between 0 and 50,000.' });
  if (!validateDate(date))
    return res.status(400).json({ error: 'Invalid date.' });

  const result = db.prepare(
    'INSERT INTO food_entries (user_id, date, food_name, calories) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, date, food_name.trim().slice(0, 200), calories);

  const entry = db.prepare('SELECT * FROM food_entries WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(entry);
});

app.delete('/api/entries/:id', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1)
    return res.status(400).json({ error: 'Invalid entry ID.' });

  const result = db.prepare(
    'DELETE FROM food_entries WHERE id = ? AND user_id = ?'
  ).run(id, req.user.id);

  if (result.changes === 0)
    return res.status(404).json({ error: 'Entry not found.' });
  res.json({ success: true });
});

// ─── 30-Day Summary ───────────────────────────────────────────────────────────

app.get('/api/summary', authenticate, (req, res) => {
  const fromDate = localDateStr(-29);

  const rows = db.prepare(`
    SELECT   date,
             SUM(calories) AS total_calories,
             COUNT(*)      AS entry_count
    FROM     food_entries
    WHERE    user_id = ? AND date >= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(req.user.id, fromDate);

  res.json(rows);
});

// ─── SPA Catch-all ────────────────────────────────────────────────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅  Calorie tracker running → http://localhost:${PORT}`);
  if (JWT_SECRET.startsWith('CHANGE-THIS'))
    console.warn('⚠️   Set a real JWT_SECRET environment variable before deploying!');
});
