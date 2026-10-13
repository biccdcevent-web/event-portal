'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
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
if (!ADMIN_KEY) console.warn('ADMIN_KEY is not set: the CSV export is disabled.');

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

const q = {
  byEmail: db.prepare('SELECT * FROM registrations WHERE email = ?'),
  byCode: db.prepare('SELECT * FROM registrations WHERE pass_code = ?'),
  insert: db.prepare(`INSERT INTO registrations
      (pass_code, full_name, designation, company_name, company_address, contact_number, email)
      VALUES (@pass_code, @full_name, @designation, @company_name, @company_address, @contact_number, @email)`),
  markSent: db.prepare(`UPDATE registrations SET email_sent_at = datetime('now') WHERE id = ?`),
  checkIn: db.prepare(`UPDATE registrations SET checked_in_at = datetime('now') WHERE pass_code = ? AND checked_in_at IS NULL`),
  all: db.prepare('SELECT * FROM registrations ORDER BY id'),
  counts: db.prepare('SELECT COUNT(*) AS total, COUNT(checked_in_at) AS checkedIn FROM registrations'),
};

// ---------------------------------------------------------------- passes
// Pass code: 8 characters without look-alikes (no 0/O, 1/I). The QR holds "CODE.SIGNATURE",
// where the signature is an HMAC, so a pass can't be invented without PASS_SECRET.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
const sign = (code) => crypto.createHmac('sha256', PASS_SECRET).update(code).digest('base64url').slice(0, 16);
const tokenFor = (code) => `${code}.${sign(code)}`;
const pretty = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
const sqlTimeToIso = (t) => (t ? t.replace(' ', 'T') + 'Z' : null);

function parseToken(raw) {
  const s = String(raw || '').trim();
  const signed = s.match(/^([A-Z2-9]{8})\.([A-Za-z0-9_-]{16})$/);
  if (signed) {
    const ok = crypto.timingSafeEqual(Buffer.from(sign(signed[1])), Buffer.from(signed[2]));
    return ok ? { code: signed[1] } : null;
  }
  // Typed-in code from the email (staff only), e.g. "K7Q2-M9XD"
  const typed = s.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z2-9]{8}$/.test(typed) ? { code: typed } : null;
}

const qrPng = (code) =>
  QRCode.toBuffer(tokenFor(code), {
    type: 'png', width: 520, margin: 2, errorCorrectionLevel: 'M',
    color: { dark: '#16223A', light: '#FFFFFF' },
  });

async function sendPass(row, png) {
  png = png || (await qrPng(row.pass_code));
  await sendPassEmail({ attendee: row, passCode: pretty(row.pass_code), qrPng: png, event: EVENT });
  q.markSent.run(row.id);
}

// ---------------------------------------------------------------- validation
const LIMITS = {
  full_name: [2, 120],
  designation: [2, 100],
  company_name: [2, 150],
  company_address: [5, 300],
  contact_number: [7, 25],
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
  if (!errors.contact_number) {
    const digits = v.contact_number.replace(/\D/g, '').length;
    if (!/^\+?[\d\s\-().]+$/.test(v.contact_number) || digits < 7 || digits > 15) {
      errors.contact_number = 'Enter a valid phone number, like +63 917 123 4567.';
    }
  }
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
app.get('/api/admin/registrations.csv', pinFailLimiter, (req, res) => {
  if (!secretMatches(req.get('x-admin-key') || req.query.key, ADMIN_KEY)) return res.status(401).send('Unauthorized');

  const cell = (value, guardFormula = true) => {
    let s = value == null ? '' : String(value);
    if (guardFormula && /^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = ['Pass code', 'Full name', 'Designation', 'Company', 'Company address', 'Contact number', 'Email',
    'Registered (UTC)', 'Pass emailed (UTC)', 'Checked in (UTC)'];
  const lines = [header.map((h) => cell(h)).join(',')];
  for (const r of q.all.all()) {
    lines.push([
      cell(pretty(r.pass_code)), cell(r.full_name), cell(r.designation), cell(r.company_name),
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

app.use('/api', (req, res) => res.status(404).json({ message: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'The request could not be read.' });
  res.status(500).json({ message: 'Something went wrong on the server. Try again.' });
});

app.listen(PORT, () => {
  console.log(`Registration page: http://localhost:${PORT}/`);
  console.log(`Staff check-in:    http://localhost:${PORT}/checkin`);
});
