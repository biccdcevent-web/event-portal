'use strict';
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

let transporter = null;
let devMode = false;

function getTransport() {
  if (transporter) return transporter;
  if (process.env.SMTP_HOST) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  } else {
    // No SMTP configured: build the full email and save it to ./outbox for inspection.
    devMode = true;
    transporter = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    console.warn('[mail] SMTP_HOST is not set. Emails will be saved to ./outbox instead of being sent.');
  }
  return transporter;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function buildHtml({ attendee, passCode, event }) {
  const first = attendee.first_name || attendee.full_name.split(' ')[0];
  const font = "font-family:Arial,Helvetica,sans-serif;";
  const row = (label, value) =>
    `<tr><td style="${font}padding:6px 0;color:#5B6678;font-size:13px;width:110px;vertical-align:top">${label}</td>` +
    `<td style="${font}padding:6px 0;color:#16223A;font-size:14px">${esc(value)}</td></tr>`;

  return `<!doctype html><html><body style="margin:0;background:#E9EDF1;padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden">
  <tr><td style="${font}background:#2D5BE3;color:#ffffff;padding:24px 28px">
    <div style="font-size:21px;font-weight:bold;line-height:1.25">${esc(event.name)}</div>
    ${event.date ? `<div style="font-size:14px;margin-top:6px;opacity:.9">${esc(event.date)}</div>` : ''}
    ${event.venue ? `<div style="font-size:14px;opacity:.9">${esc(event.venue)}</div>` : ''}
  </td></tr>
  <tr><td style="${font}padding:28px;color:#16223A;font-size:15px;line-height:1.55">
    <p style="margin:0 0 12px">Hi ${esc(first)},</p>
    <p style="margin:0 0 20px">You're registered. The QR code below is your pass. Show it at the registration desk when you arrive, either on your phone or printed.</p>
    <div style="text-align:center;margin:0 0 8px">
      <img src="cid:passqr" width="240" height="240" alt="Your QR pass" style="display:inline-block;border:1px solid #C9D1DB;border-radius:10px">
    </div>
    <div style="text-align:center;font-family:'Courier New',monospace;font-size:20px;font-weight:bold;letter-spacing:3px;margin:0 0 24px">${esc(passCode)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E1E6EC;padding-top:8px">
      ${row('Name', attendee.full_name)}
      ${row('Designation', attendee.designation)}
      ${row('Company', attendee.company_name)}
    </table>
    <p style="margin:24px 0 0;color:#5B6678;font-size:13px">This pass admits one person. Please don't post it publicly. If the code won't scan, staff can type in the pass code shown above.</p>
  </td></tr>
</table>
<p style="${font}text-align:center;color:#5B6678;font-size:12px;margin:16px 0 0">Sent by ${esc(event.organizer)} because you registered for ${esc(event.name)}.</p>
</body></html>`;
}

function buildText({ attendee, passCode, event }) {
  return [
    `Hi ${attendee.first_name || attendee.full_name.split(' ')[0]},`,
    '',
    `You're registered for ${event.name}.`,
    event.date ? `When: ${event.date}` : null,
    event.venue ? `Where: ${event.venue}` : null,
    '',
    `Your pass code: ${passCode}`,
    'Your QR pass is attached. Show it at the registration desk when you arrive.',
    '',
    `Name: ${attendee.full_name}`,
    `Designation: ${attendee.designation}`,
    `Company: ${attendee.company_name}`,
    '',
    'This pass admits one person. Please don\'t post it publicly.',
  ].filter((l) => l !== null).join('\n');
}

async function sendPassEmail({ attendee, passCode, qrPng, event }) {
  const t = getTransport();
  const info = await t.sendMail({
    from: process.env.MAIL_FROM || `"${event.name}" <no-reply@example.com>`,
    to: attendee.email,
    subject: `Your pass for ${event.name}`,
    text: buildText({ attendee, passCode, event }),
    html: buildHtml({ attendee, passCode, event }),
    attachments: [
      { filename: `pass-${passCode}.png`, content: qrPng, contentType: 'image/png', cid: 'passqr' },
    ],
  });

  if (devMode) {
    const dir = path.join(__dirname, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${passCode}.eml`);
    fs.writeFileSync(file, info.message);
    console.log(`[mail] Saved email for ${attendee.email} to ${path.relative(process.cwd(), file)}`);
  }
  return info;
}

module.exports = { sendPassEmail };
