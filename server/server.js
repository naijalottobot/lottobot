/* LOTTO backend — hourly free lotto.
   Deploy: Render (web service) + Neon (Postgres). Frontend: set API_BASE to this URL.
   Engine mirrors js/app.js exactly: same round IDs, same seeded draw. */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

for (const k of ["BOT_TOKEN", "ADMIN_KEY", "DATABASE_URL", "DRAW_SECRET", "MODE", "MONETAG_POSTBACK_KEY"]) {
  if (process.env[k]) process.env[k] = process.env[k].trim();
}

/* ================= MODE: test | live (from .env) =================
   TEST: local development — relaxed Telegram checks, missing secrets warn.
   LIVE: production — missing DATABASE_URL / BOT_TOKEN / ADMIN_KEY, or a
   default DRAW_SECRET, stops the server before it can serve anyone. */
const MODE = String(process.env.MODE || "test").toLowerCase() === "live" ? "live" : "test";
const IS_LIVE = MODE === "live";
const DEFAULT_SECRETS = ["", "lottobot-demo-v1", "change-me-to-a-long-random-string"];

function checkLiveEnv() {
  const missing = [];
  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
  if (!process.env.BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!process.env.ADMIN_KEY) missing.push("ADMIN_KEY");
  if (!process.env.DRAW_SECRET || DEFAULT_SECRETS.includes(process.env.DRAW_SECRET)) missing.push("DRAW_SECRET (must be a unique random string)");
  if (missing.length) {
    console.error("[lotto] LIVE mode refusing to start — set these in server/.env:");
    missing.forEach((m) => console.error("  - " + m));
    process.exit(1);
  }
}

const DRAW_SECRET = process.env.DRAW_SECRET || "lottobot-demo-v1";
const PRIZES = { 1: 1, 2: 50, 3: 100, 4: 500, 5: 10000 };
const MAX_TICKETS_PER_ROUND = 5;
const WITHDRAW_MIN = 500;

/* ================= ENGINE (must match js/app.js) ================= */
function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = "0" + n; return n; }
function lagosParts(ts) {
  const d = new Date((ts === undefined ? Date.now() : ts) + 3600000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
function hourLetter(h) { return String.fromCharCode(65 + h); }
function roundIdFor(ts) {
  const p = lagosParts(ts);
  return "NG" + pad(p.d) + pad(p.mo) + pad(p.y, 4) + hourLetter(p.h);
}
function roundHourStart(roundId) {
  const m = /^NG(\d{2})(\d{2})(\d{4})([A-X])$/.exec(roundId || "");
  if (!m) return 0;
  const h = m[4].charCodeAt(0) - 65;
  return Date.UTC(+m[3], +m[2] - 1, +m[1], h, 0, 0) - 3600000;
}
function roundStatusAt(ts) {
  const p = lagosParts(ts);
  if (p.mi <= 50) return "OPEN";
  if (p.mi === 51) return "DRAWING";
  return "RESULTS";
}
function cyrb53(str, seed) {
  let h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededDraw(roundId) {
  const seed = cyrb53(roundId + "|" + DRAW_SECRET, 0);
  const rand = mulberry32(seed >>> 0);
  const pool = [];
  for (let i = 1; i <= 100; i++) pool.push(i);
  const out = [];
  for (let k = 0; k < 5; k++) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out.sort((a, b) => a - b);
}
function countMatches(a, b) {
  const set = {};
  b.forEach((n) => (set[n] = 1));
  return a.filter((n) => set[n]).length;
}
const prizeFor = (m) => PRIZES[m] || 0;
const makeTicketId = (roundId, serial) => roundId + pad(serial, 10);
function validPick(arr) {
  if (!Array.isArray(arr) || arr.length !== 5) return false;
  const seen = {};
  for (const n of arr) {
    if (typeof n !== "number" || n % 1 !== 0 || n < 1 || n > 100 || seen[n]) return false;
    seen[n] = 1;
  }
  return true;
}

/* ================= AUTH ================= */
function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const dataCheckString = check.map(([k, v]) => k + "=" + v).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
    const calc = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
    if (calc !== hash) return null;
    const user = params.get("user");
    return user ? JSON.parse(user) : null;
  } catch (e) { return null; }
}
function identify(req) {
  const tgId = String((req.query.tgId || (req.body && req.body.tgId) || "")).trim();
  const initData = req.query.initData || (req.body && req.body.initData) || "";
  const name = String((req.query.name || (req.body && req.body.name) || "")).slice(0, 80);
  if (!tgId) return { error: "tgId is required" };
  const isDev = tgId.indexOf("dev-") === 0 || tgId === "guest";
  let tgUser = null;
  if (process.env.BOT_TOKEN && !isDev) {
    tgUser = verifyInitData(initData, process.env.BOT_TOKEN);
    if (!tgUser) return { error: "invalid initData" };
    if (String(tgUser.id) !== tgId) return { error: "tgId mismatch" };
  } else if (initData && process.env.BOT_TOKEN) {
    tgUser = verifyInitData(initData, process.env.BOT_TOKEN);
  }
  /* TEST mode: no BOT_TOKEN configured yet — accept the caller's name as-is
     so local development works without Telegram. LIVE always has BOT_TOKEN
     (enforced at startup), so strangers can't spoof other users. */
  return { tgId, name: name || (tgUser && (tgUser.first_name || tgUser.username)) || "", tgUser };
}
function requireAdmin(req, res, next) {
  const key = req.get("x-admin-key") || req.query.key || (req.body && req.body.key);
  if (!process.env.ADMIN_KEY) return res.status(500).json({ ok: false, error: "ADMIN_KEY is not configured" });
  if (key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}
const dbDown = (res, err) => {
  if (err && err.code === "NO_DATABASE") return res.status(503).json({ ok: false, error: "database not configured" });
  console.error("[api]", err && err.message);
  return res.status(500).json({ ok: false, error: "server error" });
};

/* ================= DRAW CORE ================= */
async function ensureRound(roundId) {
  await db.q(
    "INSERT INTO rounds (round_id, hour_start, status) VALUES ($1, $2, 'open') ON CONFLICT (round_id) DO NOTHING",
    [roundId, roundHourStart(roundId)]
  );
  await db.q("INSERT INTO round_counters (round_id, next_serial) VALUES ($1, 1) ON CONFLICT (round_id) DO NOTHING", [roundId]);
}
async function runDraw(roundId) {
  await ensureRound(roundId);
  const cur = await db.q("SELECT winning FROM rounds WHERE round_id = $1", [roundId]);
  if (cur.rows[0] && cur.rows[0].winning) return cur.rows[0].winning;
  const winning = seededDraw(roundId);
  await db.q("UPDATE rounds SET winning = $1::jsonb, status = 'drawn', drawn_at = now() WHERE round_id = $2", [JSON.stringify(winning), roundId]);
  const t = await db.q("SELECT id, tg_id, ticket_id, numbers FROM tickets WHERE round_id = $1 AND matches IS NULL", [roundId]);
  for (const row of t.rows) {
    const nums = row.numbers;
    const m = countMatches(nums, winning);
    const prize = prizeFor(m);
    await db.q("UPDATE tickets SET matches = $1, prize = $2 WHERE id = $3", [m, prize, row.id]);
    if (prize > 0) {
      await db.q("UPDATE users SET balance = balance + $1, updated_at = now() WHERE tg_id = $2", [prize, row.tg_id]);
      await db.q("INSERT INTO activity (tg_id, what, amount, plus) VALUES ($1, $2, $3, TRUE)", [
        row.tg_id,
        "Lotto win · " + String(row.ticket_id).slice(-6) + " (" + m + " match" + (m > 1 ? "es" : "") + ")",
        prize,
      ]);
    }
  }
  return winning;
}
/* Scheduler: every 20s, draw any round whose :51 has passed. */
async function schedulerTick() {
  if (!process.env.DATABASE_URL) return;
  try {
    const now = Date.now();
    /* Current round needing a draw + the previous hour (safety if server slept) */
    for (const ts of [now, now - 3600000]) {
      const rid = roundIdFor(ts);
      const p = lagosParts(ts);
      const isPastHour = ts < now;
      if (p.mi >= 51 || isPastHour) {
        await ensureRound(rid);
        const cur = await db.q("SELECT winning FROM rounds WHERE round_id = $1", [rid]);
        if (!cur.rows[0].winning) await runDraw(rid);
      } else {
        await ensureRound(rid);
      }
    }
  } catch (e) { console.error("[scheduler]", e.message); }
}

/* ================= MONETAG SERVER-SIDE POSTBACKS =================
   In your Monetag dashboard, set the postback URL to:
     https://YOUR-API.onrender.com/api/monetag/postback?key=YOUR_POSTBACK_KEY
   Monetag calls it (GET) for each verified impression/click, e.g.:
     ?ymid=user123&event=click&zone_id=11837081&request_var=ticket2&telegram_id=123&estimated_price=0.0023
   Set MONETAG_POSTBACK_KEY in .env (and in the dashboard URL) so strangers
   can't forge events. Leave it empty only for initial testing. */
function monetagPostback(req, res) {
  const secret = process.env.MONETAG_POSTBACK_KEY || "";
  const q = req.query || {};
  if (secret && q.key !== secret) return res.status(401).send("bad key");
  const tgId = String(q.telegram_id || q.tgId || "").slice(0, 64);
  const event = String(q.event || "impression").slice(0, 20);
  const zone = String(q.zone_id || q.zone || "").slice(0, 32);
  const rvar = String(q.request_var || "").slice(0, 60);
  const ymid = String(q.ymid || "").slice(0, 80);
  const price = Number(q.estimated_price) || 0;
  db.q(
    "INSERT INTO ad_events (tg_id, ymid, event, zone_id, request_var, estimated_price, raw) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
    [tgId, ymid, event, zone, rvar, price, JSON.stringify(q)]
  ).catch((e) => console.error("[postback]", e.message));
  res.status(200).send("ok");
}
app.get("/api/monetag/postback", monetagPostback);
app.post("/api/monetag/postback", monetagPostback);

/* ================= PUBLIC API ================= */
app.get("/", (req, res) => res.json({ ok: true, service: "LOTTO backend", health: "/api/health", admin: "/admin" }));
app.get("/api/health", (req, res) => res.json({ ok: true, mode: MODE, db: !!process.env.DATABASE_URL, time: new Date().toISOString() }));
app.get("/api/version", (req, res) => res.json({ ok: true, commit: process.env.RENDER_GIT_COMMIT || "local", time: new Date().toISOString() }));

app.get("/api/me", async (req, res) => {
  const id = identify(req);
  if (id.error) return res.status(400).json({ ok: false, error: id.error });
  try {
    await db.q("INSERT INTO users (tg_id, name) VALUES ($1, $2) ON CONFLICT (tg_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()", [id.tgId, id.name]);
    const u = await db.q("SELECT balance FROM users WHERE tg_id = $1", [id.tgId]);
    const c = await db.q("SELECT COUNT(*)::int AS c FROM tickets WHERE tg_id = $1", [id.tgId]);
    res.json({ ok: true, balance: Number(u.rows[0].balance), tickets: c.rows[0].c });
  } catch (err) { dbDown(res, err); }
});

app.get("/api/round/current", async (req, res) => {
  try {
    const rid = roundIdFor(Date.now());
    const status = roundStatusAt(Date.now());
    await ensureRound(rid);
    let winning = null;
    if (status === "RESULTS") winning = await runDraw(rid);
    else {
      const cur = await db.q("SELECT winning FROM rounds WHERE round_id = $1", [rid]);
      winning = (cur.rows[0] && cur.rows[0].winning) || null;
    }
    const top = await db.q(
      "SELECT ticket_id AS \"ticketId\", name, numbers, matches, prize FROM tickets WHERE round_id = $1 AND matches >= 2 ORDER BY matches DESC, ticket_id ASC LIMIT 10",
      [rid]
    );
    res.json({ ok: true, roundId: rid, status, winning, top10: top.rows, serverTime: new Date().toISOString() });
  } catch (err) { dbDown(res, err); }
});

app.post("/api/tickets", async (req, res) => {
  const id = identify(req);
  if (id.error) return res.status(400).json({ ok: false, error: id.error });
  const nums = Array.isArray(req.body && req.body.numbers) ? req.body.numbers.map(Number) : [];
  /* Keep the numbers in the order the user entered them — never sort. */
  if (!validPick(nums)) return res.status(400).json({ ok: false, error: "pick 5 different numbers, 1–100" });
  try {
    const rid = roundIdFor(Date.now());
    if (roundStatusAt(Date.now()) !== "OPEN" || (req.body && req.body.roundId && req.body.roundId !== rid)) {
      return res.status(400).json({ ok: false, error: "entries closed — wait for the next round" });
    }
    await db.q("INSERT INTO users (tg_id, name) VALUES ($1, $2) ON CONFLICT (tg_id) DO UPDATE SET name = EXCLUDED.name", [id.tgId, id.name]);
    await ensureRound(rid);
    const cnt = await db.q("SELECT COUNT(*)::int AS c FROM tickets WHERE round_id = $1 AND tg_id = $2", [rid, id.tgId]);
    if (cnt.rows[0].c >= MAX_TICKETS_PER_ROUND) return res.status(400).json({ ok: false, error: "entry limit reached (5 per round)" });
    /* Random 10-digit ticket serial (0000000000–9999999999), unique per ticket. */
    let ticketId = null;
    for (let attempt = 0; attempt < 10 && !ticketId; attempt++) {
      const rand10 = String(crypto.randomInt(0, 10000000000)).padStart(10, "0");
      const cand = rid + rand10;
      const exists = await db.q("SELECT 1 FROM tickets WHERE ticket_id = $1", [cand]);
      if (!exists.rows[0]) ticketId = cand;
    }
    if (!ticketId) return res.status(500).json({ ok: false, error: "could not issue ticket — try again" });
    const name = id.name || ("user" + String(id.tgId).slice(-4));
    await db.q("INSERT INTO tickets (ticket_id, round_id, tg_id, name, numbers) VALUES ($1, $2, $3, $4, $5::jsonb)", [ticketId, rid, id.tgId, name, JSON.stringify(nums)]);
    await db.q("INSERT INTO activity (tg_id, what, amount, plus) VALUES ($1, $2, 0, TRUE)", [id.tgId, "Lotto entry · " + ticketId]);
    const u = await db.q("SELECT balance FROM users WHERE tg_id = $1", [id.tgId]);
    res.json({ ok: true, ticket: { ticketId, roundId: rid, numbers: nums }, balance: Number(u.rows[0].balance) });
  } catch (err) { dbDown(res, err); }
});

app.get("/api/my-tickets", async (req, res) => {
  const id = identify(req);
  if (id.error) return res.status(400).json({ ok: false, error: id.error });
  try {
    const t = await db.q(
      `SELECT t.ticket_id AS "ticketId", t.round_id AS "roundId", t.numbers, t.matches, t.prize, t.created_at,
              r.winning
         FROM tickets t LEFT JOIN rounds r ON r.round_id = t.round_id
        WHERE t.tg_id = $1 ORDER BY t.id DESC LIMIT 100`,
      [id.tgId]
    );
    res.json({ ok: true, tickets: t.rows });
  } catch (err) { dbDown(res, err); }
});

/* Previous draws — 20 per page, newest first (current round first). */
app.get("/api/rounds", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const per = 20;
  try {
    const cur = roundIdFor(Date.now());
    await ensureRound(cur);
    const totalR = await db.q("SELECT COUNT(*)::int AS c FROM rounds");
    const totalPages = Math.max(1, Math.ceil((totalR.rows[0].c || 1) / per));
    const rows = await db.q(
      `SELECT r.round_id AS "roundId", r.winning, r.hour_start AS "hourStart",
              (SELECT COUNT(*)::int FROM tickets t WHERE t.round_id = r.round_id AND t.matches >= 1) AS winners
         FROM rounds r ORDER BY r.hour_start DESC LIMIT $1 OFFSET $2`,
      [per, (page - 1) * per]
    );
    res.json({ ok: true, rounds: rows.rows, page, totalPages, per });
  } catch (err) { dbDown(res, err); }
});

/* Draw detail — winning numbers + ALL winners 5→1 with user, ticket, amount. */
app.get("/api/round/:roundId", async (req, res) => {
  const rid = String(req.params.roundId || "");
  if (!/^NG\d{8}[A-X]$/.test(rid)) return res.status(400).json({ ok: false, error: "bad round id" });
  try {
    const r = await db.q("SELECT winning FROM rounds WHERE round_id = $1", [rid]);
    let winning = r.rows[0] && r.rows[0].winning;
    if (!winning && rid !== roundIdFor(Date.now())) winning = await runDraw(rid);
    const w = await db.q(
      'SELECT ticket_id AS "ticketId", name, numbers, matches, prize FROM tickets WHERE round_id = $1 AND matches >= 1 ORDER BY matches DESC, ticket_id ASC',
      [rid]
    );
    res.json({ ok: true, roundId: rid, winning, winners: w.rows });
  } catch (err) { dbDown(res, err); }
});

app.get("/api/wallet", async (req, res) => {
  const id = identify(req);
  if (id.error) return res.status(400).json({ ok: false, error: id.error });
  try {
    const u = await db.q("SELECT balance FROM users WHERE tg_id = $1", [id.tgId]);
    const a = await db.q("SELECT what, amount, plus, created_at FROM activity WHERE tg_id = $1 ORDER BY id DESC LIMIT 60", [id.tgId]);
    const w = await db.q("SELECT amount, account, bank, account_number AS \"accountNumber\", account_name AS \"accountName\", status, created_at FROM withdrawals WHERE tg_id = $1 ORDER BY id DESC LIMIT 20", [id.tgId]);
    res.json({ ok: true, balance: u.rows[0] ? u.rows[0].balance : 0, activity: a.rows, withdrawals: w.rows });
  } catch (err) { dbDown(res, err); }
});

app.post("/api/withdraw", async (req, res) => {
  const id = identify(req);
  if (id.error) return res.status(400).json({ ok: false, error: id.error });
  const amount = Math.floor(Number(req.body && req.body.amount));
  const bank = String((req.body && req.body.bank) || "").slice(0, 60).trim();
  const accountNumber = String((req.body && (req.body.accountNumber || req.body.account_number)) || "").trim();
  const accountName = String((req.body && (req.body.accountName || req.body.account_name)) || "").slice(0, 80).trim();
  /* Back-compat: older app versions send one combined "account" string. */
  const legacy = String((req.body && req.body.account) || "").slice(0, 140);
  if (!bank && !accountNumber && !accountName && !legacy) return res.status(400).json({ ok: false, error: "bank details are required" });
  if (!bank && !legacy) return res.status(400).json({ ok: false, error: "bank name is required" });
  if (accountNumber && !/^\d{6,20}$/.test(accountNumber)) return res.status(400).json({ ok: false, error: "invalid account number" });
  if (!accountNumber && !legacy) return res.status(400).json({ ok: false, error: "account number is required" });
  if (!accountName && !legacy) return res.status(400).json({ ok: false, error: "full name on the account is required" });
  const account = legacy || (bank + " · " + accountNumber + " · " + accountName);
  if (!(amount >= WITHDRAW_MIN)) return res.status(400).json({ ok: false, error: "minimum withdrawal is " + WITHDRAW_MIN });
  try {
    const u = await db.q("SELECT balance FROM users WHERE tg_id = $1", [id.tgId]);
    if (!u.rows[0] || u.rows[0].balance < amount) return res.status(400).json({ ok: false, error: "insufficient balance" });
    await db.q("UPDATE users SET balance = balance - $1, updated_at = now() WHERE tg_id = $2", [amount, id.tgId]);
    await db.q("INSERT INTO withdrawals (tg_id, amount, account, bank, account_number, account_name, status) VALUES ($1, $2, $3, $4, $5, $6, 'pending')", [id.tgId, amount, account, bank, accountNumber, accountName]);
    await db.q("INSERT INTO activity (tg_id, what, amount, plus) VALUES ($1, $2, $3, FALSE)", [id.tgId, "Withdrawal request · " + account, amount]);
    const after = await db.q("SELECT balance FROM users WHERE tg_id = $1", [id.tgId]);
    res.json({ ok: true, balance: Number(after.rows[0].balance) });
  } catch (err) { dbDown(res, err); }
});

/* ================= ADMIN ================= */
app.get("/api/admin/overview", requireAdmin, async (req, res) => {
  try {
    const totals = await db.q(
      `SELECT (SELECT COUNT(*)::int FROM users) AS users,
              (SELECT COUNT(*)::int FROM rounds) AS rounds,
              (SELECT COUNT(*)::int FROM tickets) AS tickets,
              (SELECT COALESCE(SUM(prize), 0)::int FROM tickets) AS paid_out,
              (SELECT COUNT(*)::int FROM tickets WHERE matches >= 1) AS winners,
              (SELECT COUNT(*)::int FROM withdrawals WHERE status = 'pending') AS pending_count,
              (SELECT COALESCE(SUM(amount), 0)::int FROM withdrawals WHERE status = 'pending') AS pending_sum,
              (SELECT COUNT(*)::int FROM ad_events WHERE event = 'impression') AS ad_impressions,
              (SELECT COUNT(*)::int FROM ad_events WHERE event = 'click') AS ad_clicks,
              (SELECT COALESCE(SUM(estimated_price), 0)::float FROM ad_events) AS ad_revenue`
    );
    const adRecent = await db.q(
      `SELECT tg_id AS "tgId", event, zone_id AS "zone", request_var AS "placement",
              estimated_price AS "revenue", created_at AS "createdAt"
         FROM ad_events
        ORDER BY id DESC
        LIMIT 20`
    );
    const users = await db.q(
      `SELECT u.tg_id AS "tgId", u.name, u.balance,
              COUNT(t.id)::int AS tickets,
              COALESCE(SUM(t.prize), 0)::int AS winnings,
              u.created_at AS "joined"
         FROM users u LEFT JOIN tickets t ON t.tg_id = u.tg_id
        GROUP BY u.tg_id
        ORDER BY winnings DESC, u.created_at DESC
        LIMIT 500`
    );
    const rounds = await db.q(
      `SELECT r.round_id AS "roundId", r.winning, r.drawn_at AS "drawnAt",
              (SELECT COUNT(*)::int FROM tickets t WHERE t.round_id = r.round_id) AS tickets,
              (SELECT COUNT(*)::int FROM tickets t WHERE t.round_id = r.round_id AND t.matches >= 1) AS winners,
              (SELECT COALESCE(SUM(t.prize), 0)::int FROM tickets t WHERE t.round_id = r.round_id) AS paid
         FROM rounds r
        ORDER BY r.hour_start DESC
        LIMIT 200`
    );
    const withdrawals = await db.q(
      `SELECT id, tg_id AS "tgId", amount, bank,
              account_number AS "accountNumber", account_name AS "accountName",
              account, status, created_at AS "createdAt"
         FROM withdrawals
        ORDER BY id DESC
        LIMIT 200`
    );
    const topups = await db.q(
      `SELECT id, tg_id AS "tgId", what, amount, plus, created_at AS "createdAt"
         FROM activity
        WHERE what LIKE 'Admin%'
        ORDER BY id DESC
        LIMIT 200`
    );
    res.json({ ok: true, totals: totals.rows[0], users: users.rows, rounds: rounds.rows, withdrawals: withdrawals.rows, topups: topups.rows, adRecent: adRecent.rows });
  } catch (err) { dbDown(res, err); }
});

/* Round inspector — every ticket in a round + per-user ticket counts. */
app.get("/api/admin/round/:roundId", requireAdmin, async (req, res) => {
  const rid = String(req.params.roundId || "");
  if (!/^NG\d{8}[A-X]$/.test(rid)) return res.status(400).json({ ok: false, error: "bad round id" });
  try {
    const t = await db.q(
      'SELECT ticket_id AS "ticketId", tg_id AS "tgId", name, numbers, matches, prize FROM tickets WHERE round_id = $1 ORDER BY id',
      [rid]
    );
    const perUser = {};
    t.rows.forEach((x) => {
      const k = x.tgId;
      perUser[k] = perUser[k] || { tgId: k, name: x.name, tickets: 0, winnings: 0 };
      perUser[k].tickets += 1;
      perUser[k].winnings += Number(x.prize) || 0;
    });
    res.json({ ok: true, roundId: rid, tickets: t.rows, perUser: Object.values(perUser) });
  } catch (err) { dbDown(res, err); }
});

/* Manual top-up (or deduction with a negative amount) by Telegram ID. */
app.post("/api/admin/topup", requireAdmin, async (req, res) => {
  const tgId = String((req.body && req.body.tgId) || "").trim();
  const amount = Math.floor(Number(req.body && req.body.amount));
  const note = String((req.body && req.body.note) || "").slice(0, 120);
  if (!tgId) return res.status(400).json({ ok: false, error: "telegram ID is required" });
  if (!amount || Math.abs(amount) > 1000000) {
    return res.status(400).json({ ok: false, error: "amount must be nonzero and within ±1000000" });
  }
  try {
    await db.q("INSERT INTO users (tg_id) VALUES ($1) ON CONFLICT (tg_id) DO NOTHING", [tgId]);
    const u = await db.q("SELECT balance FROM users WHERE tg_id = $1", [tgId]);
    if (Number(u.rows[0].balance) + amount < 0) return res.status(400).json({ ok: false, error: "insufficient balance" });
    await db.q("UPDATE users SET balance = balance + $1, updated_at = now() WHERE tg_id = $2", [amount, tgId]);
    const label = (amount > 0 ? "Admin top-up" : "Admin deduction") + (note ? " · " + note : "");
    await db.q("INSERT INTO activity (tg_id, what, amount, plus) VALUES ($1, $2, $3, $4)", [tgId, label, Math.abs(amount), amount > 0]);
    const after = await db.q("SELECT balance FROM users WHERE tg_id = $1", [tgId]);
    res.json({ ok: true, balance: Number(after.rows[0].balance) });
  } catch (err) { dbDown(res, err); }
});
app.post("/api/admin/withdraw", requireAdmin, async (req, res) => {
  const wid = Math.floor(Number(req.body && req.body.id));
  const action = String((req.body && req.body.action) || "");
  if (!wid || (action !== "paid" && action !== "reject")) return res.status(400).json({ ok: false, error: "bad request" });
  try {
    const w = await db.q("SELECT * FROM withdrawals WHERE id = $1", [wid]);
    if (!w.rows[0]) return res.status(404).json({ ok: false, error: "not found" });
    if (w.rows[0].status !== "pending") return res.status(400).json({ ok: false, error: "already " + w.rows[0].status });
    if (action === "paid") {
      await db.q("UPDATE withdrawals SET status = 'paid', paid_at = now() WHERE id = $1", [wid]);
    } else {
      await db.q("UPDATE withdrawals SET status = 'rejected' WHERE id = $1", [wid]);
      await db.q("UPDATE users SET balance = balance + $1 WHERE tg_id = $2", [w.rows[0].amount, w.rows[0].tg_id]);
      await db.q("INSERT INTO activity (tg_id, what, amount, plus) VALUES ($1, 'Withdrawal refunded', $2, TRUE)", [w.rows[0].tg_id, w.rows[0].amount]);
    }
    res.json({ ok: true });
  } catch (err) { dbDown(res, err); }
});

app.use("/admin", express.static(path.join(__dirname, "public", "admin")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin", "index.html")));

if (require.main === module) {
  if (IS_LIVE) checkLiveEnv();
  else if (!process.env.DATABASE_URL) console.log("[lotto] TEST mode: no DATABASE_URL — API will answer 503, frontend stays in demo");
  const port = process.env.PORT || 3000;
  migrate().then(() => {
    app.listen(port, () => console.log("[lotto] listening on :" + port + "  MODE=" + MODE));
    setInterval(schedulerTick, 20000);
    schedulerTick();
  });
}

async function migrate() {
  if (!process.env.DATABASE_URL) { console.log("[lotto] no DATABASE_URL — running without db"); return; }
  try {
    const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    await db.q(sql);
    console.log("[lotto] schema ensured");
  } catch (e) { console.error("[lotto] migrate skipped:", e.message); }
}

module.exports = { app, migrate, MODE, seededDraw, roundIdFor, roundStatusAt, countMatches, prizeFor, makeTicketId, validPick, lagosParts };
