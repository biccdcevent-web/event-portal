'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { EventEmitter } = require('events');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const { sendPassEmail } = require('./mailer');

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT) || 3000;
const PASS_SECRET = process.env.PASS_SECRET || '';
const STAFF_PIN = process.env.STAFF_PIN || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

if (PASS_SECRET.length < 32 || PASS_SECRET.startsWith('replace-')) {
  console.error('PASS_SECRET must be set to a random value of at least 32 characters. Run `npm run secret` and put the result in .env.');
  process.exit(1);
}
if (!STAFF_PIN) console.warn('STAFF_PIN is not set: the /checkin page will reject every PIN.');
if (!ADMIN_KEY) console.warn('ADMIN_KEY is not set: the admin dashboard and CSV export are disabled.');
const EVENT_TZ = process.env.EVENT_TZ || 'Asia/Manila'; // time zone for dashboard days and times

const EVENT = {
  name: process.env.EVENT_NAME || 'Our Event',
  date: process.env.EVENT_DATE || '',
  venue: process.env.EVENT_VENUE || '',
  organizer: process.env.ORGANIZER_NAME || process.env.EVENT_NAME || 'the organizer',
};

// ---------------------------------------------------------------- database
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'registrations.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS registrations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pass_code       TEXT NOT NULL UNIQUE,
    full_name       TEXT NOT NULL,
    designation     TEXT NOT NULL,
    company_name    TEXT NOT NULL,
    company_address TEXT NOT NULL,
    contact_number  TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    email_sent_at   TEXT,
    checked_in_at   TEXT
  );
`);

// Databases created before first/last name fields existed get the new columns added.
const cols = db.prepare('PRAGMA table_info(registrations)').all().map((c) => c.name);
if (!cols.includes('first_name')) db.exec('ALTER TABLE registrations ADD COLUMN first_name TEXT');
if (!cols.includes('last_name')) db.exec('ALTER TABLE registrations ADD COLUMN last_name TEXT');

// Charts added on the admin dashboard's Analysis section (shared by all admins).
const chartsTableExisted = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='saved_charts'").get();
db.exec(`
  CREATE TABLE IF NOT EXISTS saved_charts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    dimension   TEXT NOT NULL,
    metric      TEXT NOT NULL,
    chart_type  TEXT NOT NULL,
    filter      TEXT NOT NULL DEFAULT 'all',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
if (!chartsTableExisted) {
  const seed = db.prepare('INSERT INTO saved_charts (title, dimension, metric, chart_type, filter) VALUES (?, ?, ?, ?, ?)');
  seed.run('Registrants by designation', 'designation', 'count', 'bar', 'all');
  seed.run('Share of registrants by company', 'company', 'count', 'pie', 'all');
  seed.run('Attendance rate by company', 'company', 'rate', 'bar', 'all');
  seed.run('Registrations by day of the week', 'regWeekday', 'count', 'column', 'all');
}

const q = {
  byEmail: db.prepare('SELECT * FROM registrations WHERE email = ?'),
  byCode: db.prepare('SELECT * FROM registrations WHERE pass_code = ?'),
  insert: db.prepare(`INSERT INTO registrations
      (pass_code, first_name, last_name, full_name, designation, company_name, company_address, contact_number, email)
      VALUES (@pass_code, @first_name, @last_name, @full_name, @designation, @company_name, @company_address, @contact_number, @email)`),
  markSent: db.prepare(`UPDATE registrations SET email_sent_at = datetime('now') WHERE id = ?`),
  checkIn: db.prepare(`UPDATE registrations SET checked_in_at = datetime('now') WHERE pass_code = ? AND checked_in_at IS NULL`),
  all: db.prepare('SELECT * FROM registrations ORDER BY id'),
  counts: db.prepare('SELECT COUNT(*) AS total, COUNT(checked_in_at) AS checkedIn FROM registrations'),
};

// Live updates: registrations and check-ins are announced here for the admin dashboard.
const bus = new EventEmitter();
bus.setMaxListeners(0);

// ---------------------------------------------------------------- passes
// Pass code: 8 characters without look-alikes (no 0/O, 1/I). The QR holds "CODE.SIGNATURE",
// where the signature is an HMAC, so a pass can't be invented without PASS_SECRET.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
const sign = (code) => crypto.createHmac('sha256', PASS_SECRET).update(code).digest('base64url').slice(0, 16);
const tokenFor = (code) => `${code}.${sign(code)}`;
const pretty = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
const sqlTimeToIso = (t) => (t ? t.replace(' ', 'T') + 'Z' : null);

const swapCase = (s) => s.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

function parseToken(raw) {
  const s = String(raw || '').trim();
  // Barcode scanners with Caps Lock on (or a case-conversion setting) flip letter case,
  // so also try the case-swapped version before giving up.
  for (const candidate of [s, swapCase(s)]) {
    const signed = candidate.match(/^([A-Z2-9]{8})\.([A-Za-z0-9_-]{16})$/);
    if (signed && crypto.timingSafeEqual(Buffer.from(sign(signed[1])), Buffer.from(signed[2]))) {
      return { code: signed[1] };
    }
  }
  if (/^[A-Za-z2-9]{8}\.[A-Za-z0-9_-]{16}$/.test(s)) return null; // a pass-shaped code with a bad signature
  // Typed-in code from the email (staff only), e.g. "K7Q2-M9XD"
  const typed = s.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z2-9]{8}$/.test(typed) ? { code: typed } : null;
}

const qrPng = (code) =>
  QRCode.toBuffer(tokenFor(code), {
    type: 'png', width: 520, margin: 2, errorCorrectionLevel: 'M',
    color: { dark: '#141414', light: '#FFFFFF' },
  });

async function sendPass(row, png) {
  png = png || (await qrPng(row.pass_code));
  await sendPassEmail({ attendee: row, passCode: pretty(row.pass_code), qrPng: png, event: EVENT });
  q.markSent.run(row.id);
}

// ---------------------------------------------------------------- validation
const LIMITS = {
  first_name: [1, 60],
  last_name: [1, 60],
  designation: [2, 100],
  company_name: [2, 150],
  company_address: [5, 300],
  contact_number: [8, 10],
  email: [5, 254],
};

function validate(body) {
  const v = {};
  const errors = {};
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    let s = typeof body[key] === 'string' ? body[key] : '';
    s = key === 'company_address'
      ? s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
      : s.replace(/\s+/g, ' ').trim();
    v[key] = s;
    if (!s) errors[key] = 'This field is required.';
    else if (s.length < min) errors[key] = `Enter at least ${min} characters.`;
    else if (s.length > max) errors[key] = `Keep this under ${max} characters.`;
  }
  if (!errors.email) {
    v.email = v.email.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) errors.email = 'Enter a valid email address, like name@company.com.';
  }
  // Contact number: the form fixes the +63 prefix; the attendee enters 8 to 10 digits.
  const phone = (typeof body.contact_number === 'string' ? body.contact_number : '').replace(/[\s-]/g, '').replace(/^0+/, '');
  delete errors.contact_number;
  if (!phone) errors.contact_number = 'This field is required.';
  else if (!/^\d+$/.test(phone)) errors.contact_number = 'Enter numbers only.';
  else if (phone.length < 8 || phone.length > 10) errors.contact_number = 'Enter 8 to 10 digits after +63.';
  else v.contact_number = `+63 ${phone}`;
  v.full_name = `${v.first_name} ${v.last_name}`;
  if (body.consent !== true) errors.consent = 'Tick this box to register.';
  return { v, errors };
}

function secretMatches(given, expected) {
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- app
const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const tooMany = (message) => (req, res) => res.status(429).json({ message });
const registerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, handler: tooMany('Too many registrations from this network. Try again in 15 minutes.') });
const pinFailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, handler: tooMany('Too many wrong PIN attempts. Wait 15 minutes.') });
const checkinLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, handler: tooMany('Scanning too fast. Wait a moment.') });

app.get('/api/event', (req, res) => res.json(EVENT));

app.post('/api/register', registerLimiter, async (req, res) => {
  const { v, errors } = validate(req.body || {});
  if (Object.keys(errors).length) return res.status(422).json({ errors });

  const alreadyRegistered = (row) => {
    // Never return the existing QR here: anyone could type someone else's email.
    sendPass(row).catch((err) => console.error(`[mail] Resend to ${row.email} failed:`, err.message));
    return res.status(409).json({
      message: `${row.email} is already registered. We're sending that pass to the same address again.`,
    });
  };

  const existing = q.byEmail.get(v.email);
  if (existing) return alreadyRegistered(existing);

  let row = null;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    const code = newCode();
    try {
      q.insert.run({ ...v, pass_code: code });
      row = q.byCode.get(code);
    } catch (err) {
      if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
      if (err.message.includes('email')) return alreadyRegistered(q.byEmail.get(v.email));
      // pass_code collision: try another code
    }
  }
  if (!row) return res.status(500).json({ message: 'Registration could not be saved. Try again.' });
  bus.emit('change', { type: 'registered' });

  const png = await qrPng(row.pass_code);
  let emailSent = false;
  try {
    await sendPass(row, png);
    emailSent = true;
  } catch (err) {
    console.error(`[mail] Sending to ${row.email} failed:`, err.message);
  }

  res.status(201).json({
    passCode: pretty(row.pass_code),
    fullName: row.full_name,
    email: row.email,
    emailSent,
    qr: `data:image/png;base64,${png.toString('base64')}`,
  });
});

// ---- staff check-in
app.post('/api/staff/verify', pinFailLimiter, (req, res) => {
  if (!secretMatches(req.get('x-staff-pin'), STAFF_PIN)) return res.status(401).json({ message: 'That PIN is incorrect.' });
  res.json({ ok: true, counts: q.counts.get() });
});

app.post('/api/checkin', pinFailLimiter, checkinLimiter, (req, res) => {
  if (!secretMatches(req.get('x-staff-pin'), STAFF_PIN)) return res.status(401).json({ message: 'That PIN is incorrect.' });

  const parsed = parseToken(req.body && req.body.token);
  const row = parsed && q.byCode.get(parsed.code);
  if (!row) return res.json({ status: 'invalid', message: 'This is not a valid pass for this event.', counts: q.counts.get() });

  const firstTime = q.checkIn.run(row.pass_code).changes === 1;
  if (firstTime) bus.emit('change', { type: 'checked_in' });
  const fresh = q.byCode.get(row.pass_code);
  res.json({
    status: firstTime ? 'checked_in' : 'already',
    attendee: {
      name: fresh.full_name,
      designation: fresh.designation,
      company: fresh.company_name,
      passCode: pretty(fresh.pass_code),
    },
    checkedInAt: sqlTimeToIso(fresh.checked_in_at),
    counts: q.counts.get(),
  });
});

// ---- organizer export
// Registrations made before the form had separate name fields only have full_name.
function splitName(r) {
  if (r.first_name || r.last_name) return [r.first_name || '', r.last_name || ''];
  const i = r.full_name.lastIndexOf(' ');
  return i > 0 ? [r.full_name.slice(0, i), r.full_name.slice(i + 1)] : [r.full_name, ''];
}

app.get('/api/admin/registrations.csv', pinFailLimiter, (req, res) => {
  if (!isAdmin(req)) return res.status(401).send('Unauthorized');

  const cell = (value, guardFormula = true) => {
    let s = value == null ? '' : String(value);
    if (guardFormula && /^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = ['Pass code', 'First name', 'Last name', 'Designation', 'Company', 'Company address', 'Contact number', 'Email',
    'Registered (UTC)', 'Pass emailed (UTC)', 'Checked in (UTC)'];
  const lines = [header.map((h) => cell(h)).join(',')];
  for (const r of q.all.all()) {
    lines.push([
      cell(pretty(r.pass_code)), ...splitName(r).map((n) => cell(n)), cell(r.designation), cell(r.company_name),
      cell(r.company_address), cell(r.contact_number, false), cell(r.email),
      cell(r.created_at), cell(r.email_sent_at), cell(r.checked_in_at),
    ].join(','));
  }
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="registrations-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send('\uFEFF' + lines.join('\r\n')); // BOM so Excel reads ñ and other accents correctly
});

// ---- admin dashboard
// Signing in with ADMIN_KEY sets a 12-hour session cookie. Changing ADMIN_KEY signs everyone out.
const ADMIN_COOKIE = 'bic_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;
const keyFingerprint = () => crypto.createHash('sha256').update(ADMIN_KEY).digest('hex');
const sessionSig = (exp) => crypto.createHmac('sha256', PASS_SECRET).update(`admin:${exp}:${keyFingerprint()}`).digest('base64url');

function readCookie(req, name) {
  for (const part of String(req.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  const given = req.get('x-admin-key') || req.query.key;
  if (given) return secretMatches(given, ADMIN_KEY);
  const [exp, sig] = readCookie(req, ADMIN_COOKIE).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return secretMatches(sig, sessionSig(exp));
}

const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ message: 'Sign in to view the dashboard.' }));

function setSession(req, res, exp) {
  const secure = req.secure ? '; Secure' : '';
  const value = exp ? `${exp}.${sessionSig(exp)}` : '';
  const age = exp ? Math.floor(SESSION_MS / 1000) : 0;
  res.set('Set-Cookie', `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`);
}

app.post('/api/admin/login', pinFailLimiter, (req, res) => {
  if (!secretMatches(req.body && req.body.key, ADMIN_KEY)) return res.status(401).json({ message: 'That admin key is incorrect.' });
  setSession(req, res, Date.now() + SESSION_MS);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { setSession(req, res, 0); res.json({ ok: true }); });
app.get('/api/admin/session', (req, res) => res.json({ signedIn: isAdmin(req), event: EVENT }));

// Times in the database are UTC ("YYYY-MM-DD HH:MM:SS"); the dashboard shows them in EVENT_TZ.
const utc = (t) => new Date(t.replace(' ', 'T') + 'Z');
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: EVENT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: EVENT_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const localDay = (t) => dayFmt.format(utc(t));                              // "2026-11-12"
const localMinutes = (t) => { const [h, m] = hmFmt.format(utc(t)).split(':').map(Number); return h * 60 + m; };
const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function computeStats() {
  const rows = q.all.all();
  const total = rows.length;
  const arrived = rows.filter((r) => r.checked_in_at);
  const companies = new Map();
  for (const r of rows) {
    const key = r.company_name.trim().toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
    const c = companies.get(key) || { name: r.company_name.trim(), registered: 0, arrived: 0 };
    c.registered += 1;
    if (r.checked_in_at) c.arrived += 1;
    companies.set(key, c);
  }

  // Registrations per day, gaps filled with zero (at most the last 60 days).
  const perDay = new Map();
  for (const r of rows) perDay.set(localDay(r.created_at), (perDay.get(localDay(r.created_at)) || 0) + 1);
  const registrationsByDay = [];
  if (rows.length) {
    const days = [...perDay.keys()].sort();
    let d = days[0];
    const last = days[days.length - 1];
    while (d <= last) { registrationsByDay.push({ day: d, count: perDay.get(d) || 0 }); d = addDays(d, 1); }
    registrationsByDay.splice(0, Math.max(0, registrationsByDay.length - 60));
  }

  // Arrivals in 15-minute slots on the most recent check-in day.
  let arrivals = null;
  if (arrived.length) {
    const latest = arrived.reduce((a, b) => (a.checked_in_at > b.checked_in_at ? a : b));
    const day = localDay(latest.checked_in_at);
    const mins = arrived.filter((r) => localDay(r.checked_in_at) === day).map((r) => localMinutes(r.checked_in_at));
    const start = Math.floor(Math.min(...mins) / 15) * 15;
    const end = Math.floor(Math.max(...mins) / 15) * 15;
    const slots = [];
    for (let m = start; m <= end; m += 15) slots.push({ minutes: m, count: 0 });
    for (const m of mins) slots[(Math.floor(m / 15) * 15 - start) / 15].count += 1;
    arrivals = { day, total: mins.length, slots };
  }

  const activity = [
    ...rows.map((r) => ({ type: 'registered', at: r.created_at, name: r.full_name, company: r.company_name })),
    ...arrived.map((r) => ({ type: 'checked_in', at: r.checked_in_at, name: r.full_name, company: r.company_name })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 6).map((a) => ({ ...a, at: sqlTimeToIso(a.at) }));

  return {
    event: EVENT,
    timeZone: EVENT_TZ,
    today: dayFmt.format(new Date()),
    totals: {
      registered: total,
      checkedIn: arrived.length,
      notArrived: total - arrived.length,
      companies: companies.size,
      emailsPending: rows.filter((r) => !r.email_sent_at).length,
    },
    registrationsByDay,
    arrivals,
    topCompanies: [...companies.values()].sort((a, b) => b.registered - a.registered || a.name.localeCompare(b.name)).slice(0, 8),
    activity,
    updatedAt: new Date().toISOString(),
  };
}

app.get('/api/admin/stats', requireAdmin, (req, res) => res.json(computeStats()));

app.get('/api/admin/attendees', requireAdmin, (req, res) => {
  res.json(q.all.all().reverse().map((r) => {
    const [firstName, lastName] = splitName(r);
    return {
      passCode: pretty(r.pass_code), firstName, lastName, designation: r.designation, company: r.company_name,
      contact: r.contact_number, email: r.email, registeredAt: sqlTimeToIso(r.created_at),
      emailSent: Boolean(r.email_sent_at), checkedInAt: sqlTimeToIso(r.checked_in_at),
    };
  }));
});

// ---- saved charts
const CHART_OPTIONS = {
  dimension: ['company', 'designation', 'emailDomain', 'status', 'regDay', 'regWeekday', 'regHour', 'arrival15', 'arrivalHour'],
  metric: ['count', 'checkedIn', 'rate', 'stacked'],
  chart_type: ['bar', 'column', 'line', 'pie'],
  filter: ['all', 'in', 'out'],
};
const chartQ = {
  list: db.prepare('SELECT id, title, dimension, metric, chart_type AS chartType, filter FROM saved_charts ORDER BY id'),
  count: db.prepare('SELECT COUNT(*) AS n FROM saved_charts'),
  insert: db.prepare('INSERT INTO saved_charts (title, dimension, metric, chart_type, filter) VALUES (@title, @dimension, @metric, @chart_type, @filter)'),
  remove: db.prepare('DELETE FROM saved_charts WHERE id = ?'),
};

app.get('/api/admin/charts', requireAdmin, (req, res) => res.json(chartQ.list.all()));

app.post('/api/admin/charts', requireAdmin, (req, res) => {
  const b = req.body || {};
  const c = {
    title: String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    dimension: b.dimension, metric: b.metric, chart_type: b.chartType, filter: b.filter || 'all',
  };
  for (const [k, allowed] of Object.entries(CHART_OPTIONS)) {
    if (!allowed.includes(c[k])) return res.status(422).json({ message: `Choose a valid ${k.replace('_', ' ')}.` });
  }
  if (!c.title) return res.status(422).json({ message: 'Give the chart a title.' });
  if (chartQ.count.get().n >= 30) return res.status(422).json({ message: 'The dashboard holds up to 30 charts. Remove one first.' });
  const id = chartQ.insert.run(c).lastInsertRowid;
  bus.emit('change', { type: 'charts' });
  res.status(201).json({ id });
});

app.delete('/api/admin/charts/:id', requireAdmin, (req, res) => {
  chartQ.remove.run(Number(req.params.id));
  bus.emit('change', { type: 'charts' });
  res.json({ ok: true });
});

// Server-sent events: the dashboard reloads its numbers whenever someone registers or checks in.
app.get('/api/admin/stream', requireAdmin, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  const onChange = (e) => res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  bus.on('change', onChange);
  req.on('close', () => { clearInterval(ping); bus.off('change', onChange); });
});

app.use('/api', (req, res) => res.status(404).json({ message: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'The request could not be read.' });
  res.status(500).json({ message: 'Something went wrong on the server. Try again.' });
});

app.listen(PORT, () => {
  console.log(`Registration page: http://localhost:${PORT}/`);
  console.log(`Staff check-in:    http://localhost:${PORT}/checkin`);
  console.log(`Admin dashboard:   http://localhost:${PORT}/admin`);
});
