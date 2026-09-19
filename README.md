# NairaLotto — Win ₦10,000 Every Hour (Telegram Mini App)

Free hourly lotto game: pick 5 numbers from 1–100, get a ticket like
`NG18092026A7391048261`, and watch the animated reveal at :52. Winnings credit
automatically; withdrawals from ₦500 with bank details.

- **Rounds** — hourly (Lagos time). Round ID = `NG` + `DDMMYYYY` + hour letter
  (`00:00–01:00` = A … `23:00–00:00` = X). Entries `:00–:50`, draw `:51`,
  results `:52–:59`.
- **Ticket ID** — round ID + 10 random digits (never sequential).
- **Seeded draw** — `cyrb53(roundId|DRAW_SECRET)` → `mulberry32` → 5 unique
  numbers. Same round always draws the same numbers: verifiable, not clickable.
- **Prizes** — 1 match ₦1 · 2 matches ₦50 · 3 matches ₦100 · 4 matches ₦500 ·
  5 matches ₦10,000.
- **Theme** — original fun carnival style (NOT model2): gradients, candy balls,
  Baloo 2 + Nunito.

```
lottobot/
  index.html            Frontend shell
  css/styles.css        Carnival theme (balls, slots, tickets, reveal animation)
  js/app.js             Router + lotto engine + demo mode + server sync
                        (flip APP_MODE test/live at the top of the file)
  server/
    server.js           Express API + draw scheduler (MODE=test|live from .env)
    schema.sql          Postgres schema (auto-applied on boot)
    .env                YOUR secrets (gitignored — never commit)
    .env.example        Template + docs
    test.js             Engine self-test, no DB needed
```

---

## 1. TEST mode (local, free, 5 minutes)

No accounts needed. Everything runs on your machine; the app plays in demo mode
with a simulated crowd.

```powershell
cd lottobot\server
npm install
npm test          # 24 engine checks — should all PASS
npm start         # backend on http://localhost:3000 (MODE=test)
```

Open `lottobot\index.html` in a browser (or `npx serve .` inside `lottobot\`)
and play. To test the frontend **against your local backend**, open
`js/app.js` and temporarily set:

```js
var APP_MODE = "live";
var LIVE_API = "http://localhost:3000";
```

Reload the page — entries, draws and withdrawals now go through your server.
Set it back to `"test"` when done.

`server/.env` already contains `MODE=test`. In TEST mode the server only warns
about missing secrets.

---

## 2. Going LIVE — 100% free stack (GitHub + Neon + Render)

### Step A — put the code on GitHub (free)

1. Create a free account at https://github.com and a **new public repository**,
   e.g. `nairalotto`.
2. Push this folder (run inside `lottobot\`):

```powershell
git init
git add .
git commit -m "NairaLotto hourly lotto mini app"
git branch -M main
git remote add origin https://github.com/YOURNAME/nairalotto.git
git push -u origin main
```

> `.gitignore` already excludes `server/.env` and `server/node_modules/`, so
> secrets never leave your machine.

### Step B — free Postgres on Neon (free tier)

1. Sign up at https://neon.tech (free tier: 1 project, plenty for this app).
2. **New Project** → name it `lottobot` → region closest to you → Create.
3. Copy the **connection string** (looks like
   `postgresql://user:pass@ep-xxx.neon.tech/db?sslmode=require`).
4. Tables are created automatically on first boot — no SQL to run by hand.

### Step C — free backend on Render (free tier)

1. Sign up at https://render.com (free web services sleep when idle — the app
   retries automatically, so the first request after sleep just takes ~60s).
2. **New → Web Service** → connect your `nairalotto` GitHub repo.
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - Plan: **Free**.
3. Under **Environment**, add:
   | Key | Value |
   |---|---|
   | `MODE` | `live` |
   | `DATABASE_URL` | your Neon connection string |
   | `BOT_TOKEN` | token from `@BotFather` (see Step E) |
   | `ADMIN_KEY` | a long random password (for `/admin`) |
   | `DRAW_SECRET` | a long random string, different from the default (example below) |
4. **Deploy.** In LIVE mode the server refuses to start if any of these is
   missing — check the Render logs if it won't boot.

> **Example `DRAW_SECRET`** — generate your own (don't reuse this one):
> ```powershell
> node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
> # 4f8c1a9e2b5d6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6
> ```
> Paste the output as your `DRAW_SECRET` value, e.g.
> `DRAW_SECRET=4f8c1a9e2b5d6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6`.
> Keep it secret — anyone who knows it could predict future draws.
5. Note your URL: `https://YOUR-API.onrender.com`. Check
   `https://YOUR-API.onrender.com/api/health` → `{"ok":true,"mode":"live",...}`.

### Step D — point the frontend at LIVE

1. In `js/app.js` set:
   ```js
   var APP_MODE = "live";
   var LIVE_API = "https://YOUR-API.onrender.com";
   ```
2. Commit + push — redeploy wherever the frontend is hosted:
   - **Easiest free option:** the same Render account → **New → Static Site**,
     same repo, **Publish Directory:** `.` (repo root = `lottobot/`), no build
     command. Or use GitHub Pages / any static host.
3. Open the hosted URL on your phone to playtest.

### Step E — Telegram bot wiring (free)

1. Talk to `@BotFather` → `/newbot` → copy the token into Render's
   `BOT_TOKEN` (redeploys automatically).
2. `/setmenubutton` → choose your bot → paste your **frontend** URL.
3. Open the bot → Menu button → play. Real users are verified by Telegram
   `initData`; winnings and ₦500-minimum bank withdrawals go through Neon.

### Step F — payouts (you, the admin)

Open `https://YOUR-API.onrender.com/admin`, enter `ADMIN_KEY`: pending
withdrawals show amount + bank + account number + account name. Pay manually
from your bank app, then hit **Paid** (or **Reject** to refund the balance).

---

## 3. Switching cheat-sheet

| What | TEST | LIVE |
|---|---|---|
| `server/.env` → `MODE` | `test` | `live` (Render env var) |
| Secrets required | none (warns only) | `DATABASE_URL`, `BOT_TOKEN`, `ADMIN_KEY`, unique `DRAW_SECRET` (server exits if missing) |
| `js/app.js` → `APP_MODE` | `test` (offline demo) | `live` + `LIVE_API` = Render URL |
| Telegram check | relaxed | strict `initData` verification |
| Draw secret | `lottobot-demo-v1` ok | must be unique & secret |

## 4. Verify the draw (fairness)

```powershell
cd server
node -e "const s=require('./server.js'); console.log(s.seededDraw('NG18092026A'))"
```

Same round ID + same `DRAW_SECRET` always gives the same 5 numbers — anyone can
re-run this to audit a result.

## 5. Monetag ads (later)

A `Sponsored` block sits at the bottom of the Wallet page — swap it for the
Monetag Telegram-ads snippet when ready.
