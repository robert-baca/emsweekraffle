# EMS Week 2026 — Raffle App

A self-hosted raffle web app for National EMS Week. Staff scan a QR code, register once with a 4-digit PIN, and earn one raffle entry per 15-minute visit. First-time visitors can complete a 5-question survey for 5 bonus entries. The admin panel lets you manage participants, edit survey questions, and draw a weighted random winner.

---

## Requirements

- [Node.js](https://nodejs.org/) v22.5 or newer (v24 recommended)

> The app uses Node's built-in `node:sqlite` module (stable in Node 24, experimental in v22.5+) — no native compilation or extra SQLite packages needed.

---

## Install

```bash
cd emsweekraffle
npm install
```

---

## Run

```bash
node server.js
```

The app starts on **http://localhost:3000**.
Admin panel: **http://localhost:3000/admin** (PIN: `4262`)
Or tap the **⚙ Staff Access** button at the bottom of the main page.

---

## Change the Admin Password

Open `server.js` and find this line near the top:

```js
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'EMS2026';
```

**Option A — edit the file directly:**
Change `'EMS2026'` to your new password.

**Option B — use an environment variable (recommended):**
```bash
ADMIN_PASSWORD=YourNewPassword node server.js
```
On Windows PowerShell:
```powershell
$env:ADMIN_PASSWORD="YourNewPassword"; node server.js
```

---

## Expose with ngrok (for QR code access)

1. Install ngrok: https://ngrok.com/download
2. Start the app: `node server.js`
3. In a second terminal: `ngrok http 3000`
4. Copy the `https://xxxx.ngrok-free.app` URL ngrok gives you
5. Generate a QR code pointing to that URL (e.g. https://qr-code-generator.com)
6. Print and post the QR code at your station / EMS entrance

> The ngrok URL changes each time you restart ngrok unless you have a paid plan with a static domain.

---

## Database

SQLite database file is created automatically at `database.db` in the project root on first run. Survey questions are seeded on first run if none exist.

To reset everything, delete `database.db` and restart the server.

---

## Customizing the Theme

Open `public/index.html` (user-facing) or `public/admin.html` (admin panel) and edit the CSS variables at the very top of the `<style>` block under the section labeled:

```css
/* ============================================================
   THEME — edit these to match your hospital branding
   ============================================================ */
```

Key variables:
| Variable | Default | Purpose |
|---|---|---|
| `--color-accent` | `#e63946` | Primary red — buttons, highlights |
| `--color-bg` | `#0d1b2a` | Page background |
| `--color-surface` | `#162032` | Card background |
| `--color-gold` | `#ffd700` | Star / winner highlight |

---

## EMS Week Dates

The header badge currently shows "May 17–23" (National EMS Week 2026). To change it, edit this line in `public/index.html`:

```html
<div class="header-badge">May 17–23</div>
```
