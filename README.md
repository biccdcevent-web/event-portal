# Event registration portal

Attendees register with their name, designation, company name, company address, contact number and email. On success they immediately receive an email containing a QR code, which is their pass at the door. Event staff scan passes on the `/checkin` page using any phone camera.

## What's included

| Path | What it does |
|---|---|
| `/` | Registration page. A badge preview fills in as the person types, then shows their QR pass after they register. |
| `/checkin` | Staff check-in station (PIN protected). Scans QR codes with the phone camera, or accepts a typed pass code. Shows green for a valid first entry, amber if the pass was already used, red if it isn't valid. |
| `/api/admin/registrations.csv?key=ADMIN_KEY` | Downloads every registration as a CSV that opens correctly in Excel. |

**How passes are protected.** Each QR code contains the pass code plus a cryptographic signature made with `PASS_SECRET`, so nobody can make a fake pass by guessing codes. Each pass checks in once; a second scan is flagged. If someone registers with an email that's already in the system, the existing pass is re-sent to that email address rather than shown on screen, so nobody can retrieve another person's pass by typing their email.

## Run it locally

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
npm run secret          # copy the output into PASS_SECRET in .env
# also change STAFF_PIN and ADMIN_KEY in .env
npm start
```

Open http://localhost:3000. Until you fill in the SMTP settings, emails are not sent: each one is saved to the `outbox/` folder as an `.eml` file you can open in any mail app to see exactly what attendees will receive.

## Turn on real email

Fill in `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` in `.env`.

- **Gmail / Google Workspace** (fine for a few hundred attendees): turn on 2-step verification, create an App Password at myaccount.google.com/apppasswords, then use `smtp.gmail.com`, port `465`, your address as the user and the App Password as the password. Gmail limits sending to about 500 emails a day (2,000 on Workspace).
- **Larger events**: use a transactional email service such as Brevo, SendGrid, Mailgun or Amazon SES. They all provide SMTP settings that drop straight in, and they get better inbox delivery. Verify your sending domain with them so passes don't land in spam.

## Deploy

Any host that runs Node works (Render, Railway, Fly.io, a VPS, etc.):

1. Set the variables from `.env.example` in the host's environment settings, and set `TRUST_PROXY=1`.
2. Give it a **persistent disk** and point `DB_PATH` at it (e.g. `/var/data/registrations.db`). Without one, registrations are lost when the server restarts.
3. Serve it over **HTTPS** (most hosts do this automatically). Phone cameras on the check-in page only work over HTTPS.

Never change `PASS_SECRET` after passes have been sent, or every existing pass stops scanning.

## On event day

Open `https://your-site/checkin` on each staff phone or tablet, enter the staff PIN, and allow camera access. All stations share the same live database, so a pass used at one entrance shows as already used at the others. The counter at the top shows how many attendees have checked in.

## Data privacy

The portal collects personal information, so in the Philippines it falls under the Data Privacy Act of 2012 (RA 10173). The registration form asks for consent before submitting. You should also link a short privacy notice explaining what you collect, why, and how long you keep it, restrict who has the `ADMIN_KEY`, and delete the database after the event when you no longer need it.

## Customising

Event name, date, venue and organizer come from `.env`. Colours and layout are in the `<style>` block at the top of `public/index.html` (the cobalt is `--cobalt`, the lanyard yellow is `--strap`). The email template is in `mailer.js`.
