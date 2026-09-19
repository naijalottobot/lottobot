/* LOTTO Mini App — Win ₦10,000 every hour.
   Engine spec (mirrored by server/server.js):
   - Rounds are hourly (Africa/Lagos, WAT = UTC+1, no DST).
   - Round ID: "NG" + DDMMYYYY + hour-letter (00:00-01:00=A ... 23:00-00:00=X).
     e.g. NG18092026A
   - Ticket ID: roundId + 10-digit zero-padded serial. e.g. NG18092026A0000564575
   - Entry window: minute 00-50 OPEN. Minute 51 DRAWING. Minute 52-59 RESULTS.
   - Seeded draw: cyrb53(roundId|DRAW_SECRET) -> mulberry32 -> 5 unique 1-100.
     Never plain Math.random for the winning numbers.
   - Prizes: 1 match=₦1, 2=₦50, 3=₦100, 4=₦500, 5=₦10,000. Auto-credited.
*/
(function () {
  "use strict";

  /* TEST or LIVE frontend switch.
     "test": runs fully offline in demo mode (no backend needed).
     "live": put your Render URL in LIVE_API and flip APP_MODE to "live". */
  var APP_MODE = "live";
  var LIVE_API = "https://lottobot-cto8.onrender.com";
  var API_BASE = APP_MODE === "live" ? LIVE_API : "";
  var SYM = "₦";
  var DEMO_SECRET = "lottobot-demo-v1";
  var PRIZES = { 1: 1, 2: 50, 3: 100, 4: 500, 5: 10000 };
  var MAX_TICKETS_PER_ROUND = 5;
  var PER_PAGE = 20;
  var WITHDRAW_MIN = 500;

  /* ================= LOTTO ENGINE (pure) ================= */
  function pad(n, w) {
    n = String(n);
    while (n.length < (w || 2)) n = "0" + n;
    return n;
  }
  /* Lagos wall-clock parts for any absolute timestamp. WAT = UTC+1, no DST. */
  function lagosParts(ts) {
    var d = new Date((ts === undefined ? Date.now() : ts) + 3600000);
    return {
      y: d.getUTCFullYear(),
      mo: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      h: d.getUTCHours(),
      mi: d.getUTCMinutes(),
      s: d.getUTCSeconds(),
    };
  }
  function hourLetter(h) { return String.fromCharCode(65 + h); } /* 0->A ... 23->X */
  function roundIdFor(ts) {
    var p = lagosParts(ts);
    return "NG" + pad(p.d) + pad(p.mo) + pad(p.y, 4) + hourLetter(p.h);
  }
  function roundHourStart(roundId) {
    /* Start-of-hour absolute ms for a round id (for sorting / countdowns). */
    var m = /^NG(\d{2})(\d{2})(\d{4})([A-X])$/.exec(roundId || "");
    if (!m) return 0;
    var h = m[4].charCodeAt(0) - 65;
    var utcMs = Date.UTC(+m[3], +m[2] - 1, +m[1], h, 0, 0) - 3600000;
    return utcMs;
  }
  function roundStatusAt(ts) {
    var p = lagosParts(ts);
    if (p.mi <= 50) return "OPEN";
    if (p.mi === 51) return "DRAWING";
    return "RESULTS";
  }
  function msToNextBoundary(ts) {
    var p = lagosParts(ts);
    var st = roundStatusAt(ts);
    var lagosMs = new Date((ts === undefined ? Date.now() : ts) + 3600000).getTime();
    var nextLagos;
    if (st === "OPEN") {
      nextLagos = Math.floor(lagosMs / 3600000) * 3600000 + 51 * 60000;
    } else if (st === "DRAWING") {
      nextLagos = Math.floor(lagosMs / 3600000) * 3600000 + 52 * 60000;
    } else {
      nextLagos = (Math.floor(lagosMs / 3600000) + 1) * 3600000;
    }
    return Math.max(0, nextLagos - lagosMs);
  }
  /* --- Seeded RNG: cyrb53 hash + mulberry32. Deterministic per round. --- */
  function cyrb53(str, seed) {
    var h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
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
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seededDraw(roundId, secret) {
    var seed = cyrb53(roundId + "|" + (secret || DEMO_SECRET), 0);
    var rand = mulberry32(seed >>> 0);
    var pool = [];
    for (var i = 1; i <= 100; i++) pool.push(i);
    var out = [];
    for (var k = 0; k < 5; k++) {
      var idx = Math.floor(rand() * pool.length);
      out.push(pool.splice(idx, 1)[0]);
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }
  function countMatches(a, b) {
    var set = {};
    for (var i = 0; i < b.length; i++) set[b[i]] = 1;
    var c = 0;
    for (var j = 0; j < a.length; j++) if (set[a[j]]) c++;
    return c;
  }
  function prizeFor(matches) { return PRIZES[matches] || 0; }
  function makeTicketId(roundId, serial) { return roundId + pad(serial, 10); }
  function validPick(arr) {
    if (!Array.isArray(arr) || arr.length !== 5) return false;
    var seen = {};
    for (var i = 0; i < 5; i++) {
      var n = arr[i];
      if (typeof n !== "number" || (n % 1) !== 0 || n < 1 || n > 100) return false;
      if (seen[n]) return false;
      seen[n] = 1;
    }
    return true;
  }
  function quickPick(randFn) {
    var pool = [];
    for (var i = 1; i <= 100; i++) pool.push(i);
    var out = [];
    for (var k = 0; k < 5; k++) {
      out.push(pool.splice(Math.floor((randFn || Math.random)() * pool.length), 1)[0]);
    }
    return out; /* keep entry/draw order — never sort ticket numbers */
  }

  /* ================= STATE ================= */
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function load(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }

  var balance = load("lb_balance", 0);
  var myTickets = load("lb_tickets", []);     /* {ticketId, roundId, numbers, matches, prize, when, name} */
  var history = load("lb_history", []);       /* {what, amount, plus, when} */
  var roundsCache = load("lb_rounds", {});    /* roundId -> {roundId, winning, winners:[...], drawnAt} */
  var serials = load("lb_serials", {});       /* roundId -> last serial used (mine) */
  var withdrawals = load("lb_withdrawals", []);
  if (typeof balance !== "number" || !(balance >= 0)) balance = 0;
  if (!Array.isArray(myTickets)) myTickets = [];
  if (!Array.isArray(history)) history = [];
  if (!roundsCache || typeof roundsCache !== "object") roundsCache = {};
  var drawsPage = 1, ticketsPage = 1, walletPage = 1;

  var tg = null, tgUser = null;
  function initTelegram() {
    tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    if (!tg) return;
    try { tg.ready(); tg.expand(); } catch (e) {}
    tgUser = (tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
    router();
  }
  function myName() {
    if (tgUser && tgUser.username) return "@" + tgUser.username;
    if (tgUser && tgUser.first_name) return tgUser.first_name;
    return "You";
  }
  function myId() { return tgUser && tgUser.id ? String(tgUser.id) : "guest"; }

  function saveAll() {
    store("lb_balance", balance);
    store("lb_tickets", myTickets);
    store("lb_history", history);
    store("lb_rounds", roundsCache);
    store("lb_serials", serials);
    store("lb_withdrawals", withdrawals);
  }
  function addHistory(what, amount, plus) {
    history.unshift({ what: what, amount: amount, plus: plus, when: new Date().toLocaleString() });
    if (history.length > 100) history.length = 100;
  }

  /* ================= DEMO CROWD (local mode only) =================
     Deterministic fake entries so the results board feels alive offline.
     Clearly labelled "Demo player". The live server uses real users only. */
  var DEMO_NAMES = ["LuckyAda", "NaijaKing", "BolaWins", "ChidiBoy", "FunmiCash", "EmekaGold", "TundeLuck", "AishaWin", "SeunDollars", "KemiRich", "ObiCrypto", "ZaraNaira", "DayoSharp", "NgoziStar", "FemiFast", "IfeMoney", "SadeJoy", "KunleBet", "AmaraGlow", "YemiBlaze"];
  function demoCrowd(roundId) {
    var rand = mulberry32(cyrb53("crowd|" + roundId, 7) >>> 0);
    var n = 30 + Math.floor(rand() * 18); /* 30-47 fake tickets */
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push({
        ticketId: makeTicketId(roundId, 9000000000 + i),
        name: DEMO_NAMES[Math.floor(rand() * DEMO_NAMES.length)] + Math.floor(rand() * 90 + 10),
        numbers: quickPick(rand),
        demo: true,
      });
    }
    return out;
  }

  /* ================= DEMO ROUND FINALISER ================= */
  function currentRoundId() { return roundIdFor(Date.now()); }
  function ensureDemoRound(roundId) {
    if (roundsCache[roundId]) return roundsCache[roundId];
    var rec = { roundId: roundId, winning: null, winners: [], drawnAt: null, open: true };
    roundsCache[roundId] = rec;
    return rec;
  }
  function finalizeDemoRound(roundId) {
    var rec = ensureDemoRound(roundId);
    if (rec.winning) return rec;
    var winning = seededDraw(roundId, DEMO_SECRET);
    rec.winning = winning;
    rec.drawnAt = new Date().toLocaleString();
    rec.open = false;
    var all = demoCrowd(roundId).concat(
      myTickets.filter(function (t) { return t.roundId === roundId; }).map(function (t) {
        return { ticketId: t.ticketId, name: myName(), numbers: t.numbers, mine: true };
      })
    );
    var winners = [];
    all.forEach(function (e) {
      var m = countMatches(e.numbers, winning);
      if (m >= 1) winners.push({ ticketId: e.ticketId, name: e.name, numbers: e.numbers, matches: m, prize: prizeFor(m), mine: !!e.mine, demo: !!e.demo });
    });
    winners.sort(function (a, b) { return b.matches - a.matches || (a.ticketId < b.ticketId ? -1 : 1); });
    rec.winners = winners;
    /* Credit my prizes once */
    myTickets.forEach(function (t) {
      if (t.roundId === roundId && (t.matches === undefined || t.matches === null)) {
        var m = countMatches(t.numbers, winning);
        t.matches = m;
        t.prize = prizeFor(m);
        if (t.prize > 0) {
          balance += t.prize;
          addHistory("Lotto win · " + t.ticketId.slice(-6) + " (" + m + " match" + (m > 1 ? "es" : "") + ")", t.prize, true);
        }
      }
    });
    saveAll();
    return rec;
  }
  /* Auto-finalise any past OPEN rounds left over (e.g. app was closed). */
  function sweepDemo() {
    var changed = false;
    Object.keys(roundsCache).forEach(function (rid) {
      var rec = roundsCache[rid];
      if (!rec.winning && rid !== currentRoundId() && roundHourStart(rid) < Date.now() - 3600000) {
        finalizeDemoRound(rid);
        changed = true;
      }
    });
    /* Also finalise my orphan tickets from older rounds with no cache entry */
    myTickets.forEach(function (t) {
      if ((t.matches === undefined || t.matches === null) && t.roundId !== currentRoundId()) {
        finalizeDemoRound(t.roundId);
        changed = true;
      }
    });
    if (changed) saveAll();
  }

  /* ================= SERVER SYNC (optional backend) ================= */
  function apiQS(extra) {
    var p = { tgId: myId() };
    if (tg && tg.initData) p.initData = tg.initData;
    if (tgUser && (tgUser.first_name || tgUser.username)) p.name = tgUser.first_name || tgUser.username;
    if (extra) for (var k in extra) p[k] = extra[k];
    return Object.keys(p).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(p[k]); }).join("&");
  }
  function apiGet(path) {
    if (!API_BASE || typeof fetch === "undefined") return Promise.resolve(null);
    return fetch(API_BASE + path + "?" + apiQS(), { cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .catch(function () { return null; });
  }
  function apiPost(path, body) {
    if (!API_BASE || typeof fetch === "undefined") return Promise.resolve(null);
    body = body || {};
    body.tgId = myId();
    if (tg && tg.initData) body.initData = tg.initData;
    if (tgUser && (tgUser.first_name || tgUser.username) && !body.name) body.name = tgUser.first_name || tgUser.username;
    return fetch(API_BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .catch(function () { return null; });
  }
  var serverRound = null, serverTop = [];
  function syncServer() {
    if (!API_BASE) return;
    apiGet("/api/round/current").then(function (r) {
      if (r && r.ok) { serverRound = r; if (Array.isArray(r.top10)) serverTop = r.top10; tick(); }
    });
    apiGet("/api/me").then(function (me) {
      if (me && me.ok) {
        if (typeof me.balance === "number") { balance = me.balance; saveAll(); router(); }
      }
    });
  }

  /* ================= HELPERS ================= */
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) { return SYM + Number(n || 0).toLocaleString("en-NG"); }
  function toast(msg) {
    var t = el("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }
  function icon(n) {
    var body = {
      home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/>',
      ticket: '<path d="M4 8h16v3a2 2 0 0 0 0 6v3H4v-3a2 2 0 0 0 0-6z"/><path d="M13 8v12" stroke-dasharray="2 2"/>',
      play: '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.8v6.4L14.8 12z" fill="currentColor" stroke="none"/>',
      list: '<path d="M5 7h14M5 12h14M5 17h14"/>',
      wallet: '<rect x="3.5" y="6.5" width="17" height="12.5" rx="3"/><path d="M3.5 10h17"/><circle cx="16.5" cy="14.5" r="1.2" fill="currentColor" stroke="none"/>',
      info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none"/>',
      book: '<path d="M5 5h11a3 3 0 0 1 3 3v11H8a3 3 0 0 1-3-3z"/><path d="M5 5v11a3 3 0 0 0 3 3"/>',
      clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
      chat: '<path d="M4 5.5h16v10H9.5L4 19.5z"/><path d="M8 10h8M8 12.8h5"/>'
    }[n] || "";
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + body + "</svg>";
  }
  function ballsHtml(nums, winning) {
    return '<div class="balls">' + nums.map(function (n) {
      var cls = "ball";
      var hit = winning && winning.indexOf(n) !== -1;
      if (winning) cls += hit ? " win" : " miss";
      else cls += " gold";
      return '<span class="' + cls + '">' + n + "</span>";
    }).join("") + "</div>";
  }
  function prizeTableHtml() {
    var rows = [
      { m: 5, tag: "Jackpot" },
      { m: 4, tag: "Big win" },
      { m: 3, tag: "Nice hit" },
      { m: 2, tag: "Small win" },
      { m: 1, tag: "Consolation" },
    ];
    return '<div class="panel">' + rows.map(function (r) {
      return '<div class="prow"><span class="k">' + r.m + " of 5 match" + (r.m > 1 ? "es" : "") + "<small>" + r.tag + "</small></span>" +
        '<span class="v">' + money(prizeFor(r.m)) + "</span></div>";
    }).join("") + "</div>";
  }
  function fmtCountdown(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60), ss = s % 60;
    return pad(m) + ":" + pad(ss);
  }
  /* ---- Animated winning-number reveal: slot shuffle, then balls lock
     in one-by-one with a pop + tick sound. Pure front-end theatre —
     the numbers themselves still come from the seeded draw. ---- */
  var revealLockTimer = null, revealShuffleTimer = null;
  var revealData = {};
  var audioCtx = null;
  function tickSound(final) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === "suspended") return;
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.type = "sine";
      o.frequency.value = final ? 880 : 420 + Math.random() * 260;
      var t = audioCtx.currentTime;
      g.gain.setValueAtTime(0.09, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (final ? 0.45 : 0.12));
      o.start(t); o.stop(t + (final ? 0.45 : 0.12));
    } catch (e) {}
  }
  function clearRevealTimers() {
    if (revealLockTimer) { clearInterval(revealLockTimer); revealLockTimer = null; }
    if (revealShuffleTimer) { clearInterval(revealShuffleTimer); revealShuffleTimer = null; }
  }
  function animateWinningBalls(boxId, winning) {
    var box = el(boxId);
    if (!box || !winning || !winning.length) return;
    clearRevealTimers();
    revealData[boxId] = winning.slice();
    var n = winning.length, locked = 0, i;
    var html = "";
    for (i = 0; i < n; i++) html += '<span class="ball big rolling">?</span>';
    box.innerHTML = html;
    var cells = box.children || [];
    revealShuffleTimer = setInterval(function () {
      if (!el(boxId)) { clearRevealTimers(); return; }
      for (var j = locked; j < n && j < cells.length; j++) {
        cells[j].textContent = 1 + Math.floor(Math.random() * 100);
      }
    }, 90);
    revealLockTimer = setInterval(function () {
      if (!el(boxId)) { clearRevealTimers(); return; }
      if (locked >= n) { clearRevealTimers(); return; }
      var c = cells[locked];
      if (c) {
        c.textContent = winning[locked];
        c.className = "ball big win reveal";
        tickSound(locked === n - 1);
      }
      locked++;
    }, 850);
  }
  /* Actual clock time in Lagos for an absolute timestamp, e.g. "11:50 PM". */
  function fmtLagosTime(ts) {
    var p = lagosParts(ts);
    var h12 = p.h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ":" + pad(p.mi) + " " + (p.h < 12 ? "AM" : "PM");
  }
  function roundCloseTime(rid) { return fmtLagosTime(roundHourStart(rid) + 50 * 60000); }
  function roundDrawTime(rid) { return fmtLagosTime(roundHourStart(rid) + 51 * 60000); }
  function roundResultsTime(rid) { return fmtLagosTime(roundHourStart(rid) + 52 * 60000); }
  function roundNextTime(rid) { return fmtLagosTime(roundHourStart(rid) + 3600000); }

  /* ================= SHELL ================= */
  function topbar(backTo) {
    var back = backTo
      ? '<button class="back-btn" data-nav="' + backTo + '" aria-label="Back">&#8592;</button>'
      : '<span class="back-btn" style="visibility:hidden">&#8592;</span>';
    return (
      '<header class="topbar">' +
      '<div class="tb-left">' + back + "</div>" +
      '<div class="brand"><span class="brand-mark">₦</span><span class="brand-name">NairaLotto<small>Win every hour</small></span></div>' +
      '<button class="wallet-pill" data-nav="/wallet" aria-label="Wallet"><span class="dot"></span>' + money(balance) + "</button>" +
      "</header>"
    );
  }
  function tabbar(active) {
    function tab(key, route, ic, label) {
      return '<button class="tab' + (active === key ? " active" : "") + '" data-nav="' + route + '">' + icon(ic) + "<span>" + label + "</span></button>";
    }
    return '<nav class="tabbar">' +
      tab("home", "/", "home", "Home") +
      tab("play", "/play", "play", "Play") +
      tab("draws", "/draws", "list", "Draws") +
      tab("tickets", "/tickets", "ticket", "Tickets") +
      tab("wallet", "/wallet", "wallet", "Wallet") +
      "</nav>";
  }
  function screen(html, backTo, tab) {
    clearRevealTimers();
    el("app").innerHTML = topbar(backTo) + html + tabbar(tab || "");
    window.scrollTo(0, 0);
    tick();
  }

  /* ================= PAGES ================= */
  function welcome() {
    var rid = API_BASE && serverRound ? serverRound.roundId : currentRoundId();
    var st = API_BASE && serverRound ? serverRound.status : roundStatusAt(Date.now());
    var greet = tgUser && (tgUser.first_name || tgUser.username) ? esc(tgUser.first_name || tgUser.username) : null;
    screen(
      '<div class="hero fade">' +
      '<div class="kicker">Free Hourly Draw</div>' +
      "<h1>Win <span class='amt'>" + money(10000) + " naira</span><br/><em>every hour.</em></h1>" +
      '<p class="lede">' + (greet ? "Good luck, " + greet + ". " : "") + "Pick 5 numbers from 1–100 and win " + money(10000) + " naira when all 5 numbers play on your ticket. Free entry, new draw round every hour.</p>" +
      '<div class="jackpot"><div class="jp-k">This Hour&apos;s Jackpot</div><div class="jp-v">' + money(10000) + " <small>5/5</small></div>" +
      '<div class="jp-sub">Draw <b>' + esc(rid) + "</b> · status: <b>" + esc(st) + "</b></div>" +
      '<span class="jp-round">Balance · ' + money(balance) + "</span></div>" +
      '<div class="menu">' +
      '<button class="menu-card hero-cta" data-nav="/play"><span class="menu-ic">' + icon("play") + '</span><span class="menu-tx"><span class="menu-t">Play Lotto For Free</span><span class="menu-s" style="display:block">Enter the live round · closes ' + roundCloseTime(rid) + '</span></span><span class="chev">&#8250;</span></button>' +
      '<button class="menu-card" data-nav="/how"><span class="menu-ic gold">' + icon("info") + '</span><span class="menu-tx"><span class="menu-t">How To Use App</span><span class="menu-s" style="display:block">Entries, draws &amp; payouts</span></span><span class="chev">&#8250;</span></button>' +
      '<button class="menu-card" data-nav="/draws"><span class="menu-ic">' + icon("list") + '</span><span class="menu-tx"><span class="menu-t">Previous Draws</span><span class="menu-s" style="display:block">Winning numbers &amp; winners</span></span><span class="chev">&#8250;</span></button>' +
      '<button class="menu-card" data-nav="/rules"><span class="menu-ic gold">' + icon("book") + '</span><span class="menu-tx"><span class="menu-t">Rules</span><span class="menu-s" style="display:block">Prize table &amp; fair draw</span></span><span class="chev">&#8250;</span></button>' +
      '<button class="menu-card" data-nav="/tickets"><span class="menu-ic">' + icon("ticket") + '</span><span class="menu-tx"><span class="menu-t">My Tickets</span><span class="menu-s" style="display:block">' + myTickets.length + " ticket" + (myTickets.length === 1 ? "" : "s") + " total</span></span><span class=\"chev\">&#8250;</span></button>" +
      '<button class="menu-card" data-nav="/wallet"><span class="menu-ic gold">' + icon("wallet") + '</span><span class="menu-tx"><span class="menu-t">Wallet · ' + money(balance) + '</span><span class="menu-s" style="display:block">Withdraw from ' + money(WITHDRAW_MIN) + "</span></span><span class=\"chev\">&#8250;</span></button>" +
      '<button class="menu-card" data-nav="/contact"><span class="menu-ic">' + icon("chat") + '</span><span class="menu-tx"><span class="menu-t">Contact Admin</span><span class="menu-s" style="display:block">Questions · enquiries · payment support</span></span><span class="chev">&#8250;</span></button>' +
      "</div>" +
      '<p class="muted small" style="margin-top:18px;text-align:center;letter-spacing:2px;text-transform:uppercase">Free play · Draws every hour · WAT</p>' +
      "</div>",
      null, "home"
    );
  }

  function statusBlock() {
    var rid = API_BASE && serverRound ? serverRound.roundId : currentRoundId();
    var st = API_BASE && serverRound ? serverRound.status : roundStatusAt(Date.now());
    var label = st === "OPEN" ? "Entries open" : st === "DRAWING" ? "Drawing now" : "Results out";
    var sub = st === "OPEN" ? "Closes " + roundCloseTime(rid)
      : st === "DRAWING" ? "Results " + roundResultsTime(rid)
      : "Next round " + roundNextTime(rid);
    return { rid: rid, st: st, html: '<span class="round-chip">DRAW · ' + esc(rid) + "</span>" +
      '<div class="statusbar' + (st === "OPEN" ? "" : " closed") + '"><span class="st"><span class="pulse"></span>' + label + '</span><span class="cd"><span data-cd>' + fmtCountdown(msToNextBoundary(Date.now())) + "</span><small>" + sub + "</small></span></div>" };
  }

  function play() {
    var sb = statusBlock();
    var rid = sb.rid, st = sb.st;
    var mine = myTickets.filter(function (t) { return t.roundId === rid; });
    var rec = (!API_BASE && st === "RESULTS") ? finalizeDemoRound(rid) : ensureDemoRound(rid);
    var winning = API_BASE ? (serverRound && serverRound.winning) : rec.winning;

    var resultHtml = "";
    if (st === "RESULTS") {
      if (winning && winning.length) {
        resultHtml = '<div class="pick-card" style="margin-top:14px"><h3>Winning numbers</h3><p class="hint">Drawn ' + roundDrawTime(rid) + ' · seeded draw · verifiable</p>' +
          '<div class="balls" id="winBalls"></div>' +
          '<button class="replay-btn" data-replay="winBalls">Replay reveal</button></div>';
        var top = API_BASE ? serverTop : rec.winners.filter(function (w) { return w.matches >= 2; }).slice(0, 10);
        resultHtml += '<div class="spacer"></div><div class="sec-head"><h2 style="font-size:20px">Top winners</h2><span class="count">5 → 2 matches</span></div>';
        resultHtml += '<p class="muted small" style="margin-bottom:10px">Green ball = matched number · grey = missed.</p>';
        resultHtml += top.length ? '<div class="cards">' + top.map(function (w) { return winnerCard(w, winning); }).join("") + "</div>"
          : '<div class="empty"><div class="e-ic">○</div><p>No 2+ match winners this round.</p></div>';
      } else {
        resultHtml = '<div class="notice"><h3>Drawing…</h3><p>Hold on — the draw runs at ' + roundDrawTime(rid) + " and results appear at " + roundResultsTime(rid) + ".</p></div>";
      }
    } else if (st === "DRAWING") {
      resultHtml = '<div class="notice"><h3>Draw in progress</h3><p>Entries are closed. 5 lucky numbers are being drawn with the seeded draw. Results show at ' + roundResultsTime(rid) + ".</p></div>";
    }

    var formHtml = "";
    if (st === "OPEN") {
      formHtml =
        '<div class="pick-card"><h3>Pick 5 numbers</h3><p class="hint">1 to 100 · no repeats · ' + (MAX_TICKETS_PER_ROUND - mine.length) + " of " + MAX_TICKETS_PER_ROUND + " entries left this round</p>" +
        '<div class="slots">' +
        [0, 1, 2, 3, 4].map(function (i) { return '<input class="slot" id="slot' + i + '" type="number" inputmode="numeric" min="1" max="100" placeholder="–" />'; }).join("") +
        "</div>" +
        '<div class="quick-row"><button id="qpBtn" type="button">Quick pick</button><button id="clrBtn" type="button">Clear</button></div>' +
        '<button class="btn-p" id="enterBtn"' + (mine.length >= MAX_TICKETS_PER_ROUND ? " disabled" : "") + ">" +
        (mine.length >= MAX_TICKETS_PER_ROUND ? "Entry limit reached" : "Get draw ticket · Free") + "</button></div>";
    } else {
      formHtml = '<div class="notice"><h3>Entries closed</h3><p>This round stopped taking entries at ' + roundCloseTime(rid) + ". Come back at " + roundNextTime(rid) + " for the next free round.</p></div>";
    }

    var mineHtml = '<div class="spacer"></div><div class="sec-head"><h2 style="font-size:20px">My entries</h2><span class="count">' + mine.length + " this round</span></div>";
    mineHtml += mine.length ? '<div class="cards">' + mine.slice().reverse().map(function (t) { return ticketCard(t, winning); }).join("") + "</div>"
      : '<p class="muted small">No entries in this round yet.</p>';

    screen(
      '<div class="page fade">' +
      '<div class="sec-head"><h2>Play Lotto</h2><span class="count">Free entry</span></div>' +
      '<p class="sub">Win ' + money(10000) + " naira Jackpot when all 5 numbers play.</p>" +
      sb.html + formHtml + resultHtml + mineHtml +
      "</div>",
      "/", "play"
    );

    ["slot0", "slot1", "slot2", "slot3", "slot4"].forEach(function (id) {
      var s = el(id);
      if (s) s.addEventListener("input", function () {
        s.classList.toggle("filled", !!s.value);
        if (Number(s.value) > 100) s.value = 100;
        if (Number(s.value) < 1 && s.value !== "") s.value = "";
      });
    });
    var qp = el("qpBtn");
    if (qp) qp.addEventListener("click", function () {
      var p = quickPick();
      p.forEach(function (n, i) { var s = el("slot" + i); if (s) { s.value = n; s.classList.add("filled"); } });
    });
    var cl = el("clrBtn");
    if (cl) cl.addEventListener("click", function () {
      for (var i = 0; i < 5; i++) { var s = el("slot" + i); if (s) { s.value = ""; s.classList.remove("filled"); } }
    });
    var eb = el("enterBtn");
    if (eb) eb.addEventListener("click", function () {
      var nums = [];
      for (var i = 0; i < 5; i++) { var s = el("slot" + i); nums.push(s && s.value !== "" ? Number(s.value) : NaN); }
      submitEntry(rid, nums);
    });

    if (st === "RESULTS" && winning && winning.length) animateWinningBalls("winBalls", winning);
  }

  function readSlots() { return null; }

  function submitEntry(rid, nums) {
    if (!validPick(nums)) { toast("Pick 5 different numbers, 1–100"); return; }
    /* Keep the numbers in the order the user entered them. */
    if (API_BASE) {
      toast("Sending entry…");
      apiPost("/api/tickets", { numbers: nums }).then(function (r) {
        if (r && r.ok) {
          balance = typeof r.balance === "number" ? r.balance : balance;
          myTickets.unshift({ ticketId: r.ticket.ticketId, roundId: r.ticket.roundId, numbers: r.ticket.numbers, matches: null, prize: null, when: new Date().toLocaleString(), name: myName() });
          addHistory("Lotto entry · " + r.ticket.ticketId, 0, true);
          saveAll();
          toast("Ticket " + r.ticket.ticketId);
          play();
        } else {
          toast(r && r.error ? r.error : "No reply — server may be waking up");
        }
      });
      return;
    }
    /* Local demo */
    if (roundStatusAt(Date.now()) !== "OPEN" || roundIdFor(Date.now()) !== rid) { toast("Entries closed for this round"); play(); return; }
    var mine = myTickets.filter(function (t) { return t.roundId === rid; });
    if (mine.length >= MAX_TICKETS_PER_ROUND) { toast("Entry limit reached (5)"); return; }
    var usedIds = {};
    myTickets.forEach(function (t) { if (t.roundId === rid) usedIds[t.ticketId] = 1; });
    demoCrowd(rid).forEach(function (e) { usedIds[e.ticketId] = 1; });
    var ticketId = null;
    for (var a = 0; a < 20 && !ticketId; a++) {
      var r10 = String(Math.floor(Math.random() * 10000000000));
      while (r10.length < 10) r10 = "0" + r10;
      var cand = makeTicketId(rid, r10);
      if (!usedIds[cand]) ticketId = cand;
    }
    if (!ticketId) { toast("Could not issue ticket — try again"); return; }
    var t = { ticketId: ticketId, roundId: rid, numbers: nums, matches: null, prize: null, when: new Date().toLocaleString(), name: myName() };
    myTickets.unshift(t);
    ensureDemoRound(rid);
    addHistory("Lotto entry · " + t.ticketId, 0, true);
    saveAll();
    toast("Ticket " + t.ticketId);
    play();
  }

  function ticketCard(t, winning) {
    var m = (t.matches !== undefined && t.matches !== null) ? t.matches : (winning ? countMatches(t.numbers, winning) : null);
    var badge = m === null ? '<span class="match-badge">Pending</span>' : '<span class="match-badge m' + m + '">' + m + "/5 · " + money(prizeFor(m)) + "</span>";
    return '<div class="tcard"><div class="tid">' + esc(t.ticketId) + "</div>" +
      ballsHtml(t.numbers, winning) +
      '<div class="trow"><span class="who">' + esc(t.name || myName()) + "<small>" + esc(t.roundId) + " · " + esc(t.when || "") + "</small></span>" + badge + "</div></div>";
  }
  function winnerCard(w, winning) {
    return '<div class="tcard"><div class="tid">' + esc(w.ticketId) + "</div>" +
      ballsHtml(w.numbers, winning || null) +
      '<div class="trow"><span class="who">' + esc(w.name) + (w.mine ? " · you" : "") + "<small>" + w.matches + "/5 matches</small></span>" +
      '<span class="prz">' + money(w.prize) + "<small>won</small></span></div></div>";
  }

  function howToUse() {
    screen(
      '<div class="page fade">' +
      '<div class="sec-head"><h2>How it works</h2><span class="count">4 steps</span></div>' +
      '<p class="sub">Free to play, draws every hour (WAT).</p>' +
      '<div class="steps">' +
      '<div class="step"><span class="step-n">01</span><span class="step-b">Open <b>Play Lotto For Free</b> between <b>:00–:50</b> and pick <b>5 numbers</b> from 1–100.</span></div>' +
      '<div class="step"><span class="step-n">02</span><span class="step-b">You get a <b>draw ticket</b> like <b>NG18092026A0000564575</b> for round <b>NG18092026A</b>.</span></div>' +
      '<div class="step"><span class="step-n">03</span><span class="step-b">At <b>:51</b> the system draws <b>5 lucky numbers</b> with a seeded draw (not plain random).</span></div>' +
      '<div class="step"><span class="step-n">04</span><span class="step-b">From <b>:52</b> check results — winnings land in your <b>Wallet</b> automatically. New round at the top of the hour.</span></div>' +
      "</div>" +
      '<div class="notice"><h3>Prize table</h3><p>Match numbers on your ticket against the 5 drawn numbers. Winnings credit automatically.</p></div>' +
      prizeTableHtml() +
      "</div>",
      "/", ""
    );
  }

  function rules() {
    screen(
      '<div class="page fade">' +
      '<div class="sec-head"><h2>Rules</h2></div>' +
      '<p class="sub">The official rules of play. Please read them carefully before entering a draw.</p>' +
      '<ul class="blist">' +
      "<li><b>Draw rounds.</b> Draws take place every hour, on the hour (West Africa Time). Each round carries a unique Round ID. Example: <b>NG18092026A</b>.</li>" +
      "<li><b>Entries.</b> Entry is free and open during the first 50 minutes of each hour only. Each user may submit a maximum of <b>" + MAX_TICKETS_PER_ROUND + " tickets per round</b>. Every ticket contains <b>5 distinct numbers between 1 and 100</b>, kept in the order entered.</li>" +
      "<li><b>Tickets.</b> Each entry is issued a unique Ticket ID consisting of the Round ID followed by <b>10 randomly generated digits</b> (for example, NG18092026A7391048261). Ticket numbers are random and never sequential.</li>" +
      "<li><b>The draw.</b> At 51 minutes past the hour, entries close and <b>5 winning numbers from 1 to 100</b> are drawn. The outcome of every draw is final.</li>" +
      "<li><b>Prizes.</b> Each ticket is paid according to how many of its 5 numbers match the drawn numbers. Please see the prize table below.</li>" +
      "<li><b>Results.</b> Results are published from 52 minutes past the hour until the next round begins, showing the winning numbers and the top 10 winning tickets (5 down to 2 matches). Complete winner lists (5 down to 1 match) for every past round are available at any time under Previous Draws.</li>" +
      "<li><b>Payouts.</b> All winnings are credited to your in-app balance automatically. Bank withdrawals are available from <b>" + money(WITHDRAW_MIN) + "</b>; you will be asked to provide your bank name, account number, and the full name on the account.</li>" +
      "</ul>" +
      '<div class="spacer"></div>' +
      '<div class="sec-head"><h2 style="font-size:20px">Prize table</h2></div>' +
      prizeTableHtml() +
      '<div class="notice"><h3>Fair play</h3><p>All draws are conducted fairly and every result is final. Any attempt to exploit, manipulate, or abuse the system will lead to disqualification and forfeiture of winnings.</p></div>' +
      "</div>",
      "/", ""
    );
  }

  /* ---- Previous draws, 20 per page ---- */
  function allKnownRounds() {
    if (API_BASE) return null; /* server paginates */
    sweepDemo();
    var ids = {};
    Object.keys(roundsCache).forEach(function (r) { ids[r] = 1; });
    myTickets.forEach(function (t) { ids[t.roundId] = 1; });
    /* Seed the list with the last ~72 hourly rounds so the page is useful immediately */
    var now = Date.now();
    for (var h = 0; h < 72; h++) ids[roundIdFor(now - h * 3600000)] = 1;
    var list = Object.keys(ids);
    list.sort(function (a, b) { return roundHourStart(b) - roundHourStart(a); });
    return list.map(function (rid) {
      var isCur = rid === currentRoundId();
      var rec = roundsCache[rid];
      if (!rec) {
        if (isCur) { rec = ensureDemoRound(rid); }
        else {
          /* Past round with no local data: finalise deterministically for display */
          var past = finalizeDemoRound(rid);
          rec = past;
        }
      } else if (!rec.winning && !isCur) {
        rec = finalizeDemoRound(rid);
      }
      return { roundId: rid, winning: rec.winning, winners: rec.winners || [], current: isCur };
    });
  }

  function draws() {
    if (API_BASE) { drawsServer(); return; }
    var list = allKnownRounds();
    var totalPages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    if (drawsPage > totalPages) drawsPage = totalPages;
    var items = list.slice((drawsPage - 1) * PER_PAGE, drawsPage * PER_PAGE);
    screen(
      '<div class="page fade">' +
      '<div class="sec-head"><h2>Previous Draws</h2><span class="count">' + list.length + "</span></div>" +
      '<p class="sub">Tap a draw for winning numbers + all winners from 5/5 matches to 1/5 matches.</p>' +
      '<div class="rows">' + items.map(function (r) {
        var w5 = r.winners.filter(function (w) { return w.matches === 5; }).length;
        var wtot = r.winners.length;
        var sub = r.current ? "Live now · " + roundStatusAt(Date.now())
          : r.winning ? wtot + " winning tickets" + (w5 ? " · " + w5 + " jackpot!" : "") : "Draw pending";
        return '<button class="row-card" data-nav="/draw/' + esc(r.roundId) + '"><span><span class="t" style="display:block">' + esc(r.roundId) + '</span><span class="s">' +
          (r.winning ? "★ " + r.winning.join(" · ") + "<br/>" : "") + esc(sub) + "</span></span>" + '<span class="chev">&#8250;</span></button>';
      }).join("") + "</div>" +
      (totalPages > 1 ? '<div class="apager"><button data-dpage="-1"' + (drawsPage <= 1 ? " disabled" : "") + ">← Previous</button>" +
        '<span class="apg-info">Page ' + drawsPage + " of " + totalPages + "</span>" +
        '<button data-dpage="1"' + (drawsPage >= totalPages ? " disabled" : "") + ">Next →</button></div>" : "") +
      "</div>",
      "/", "draws"
    );
  }

  var serverDraws = [], serverDrawsPage = 1, serverDrawsTotal = 1;
  var drawWinnersPage = 1, drawWinnersKey = "";
  var serverDrawWinners = [], serverDrawWinnersPage = 1, serverDrawWinnersKey = "", serverDrawWinning = null;
  function winnersPagerHtml(page, totalPages, attr) {
    if (totalPages <= 1) return "";
    return '<div class="apager"><button ' + attr + '="-1"' + (page <= 1 ? " disabled" : "") + ">← Previous</button>" +
      '<span class="apg-info">Page ' + page + " of " + totalPages + "</span>" +
      '<button ' + attr + '="1"' + (page >= totalPages ? " disabled" : "") + ">Next →</button></div>";
  }
  function drawsServer() {
    apiGet("/api/rounds").then(function (r) {
      if (r && r.ok) { serverDraws = r.rounds || []; serverDrawsPage = r.page || 1; serverDrawsTotal = r.totalPages || 1; }
      screen(
        '<div class="page fade">' +
        '<div class="sec-head"><h2>Previous Draws</h2><span class="count">live</span></div>' +
        '<p class="sub">Tap a draw for winning numbers + all winners from 5/5 matches to 1/5 matches.</p>' +
        (serverDraws.length ? '<div class="rows">' + serverDraws.map(function (x) {
          return '<button class="row-card" data-nav="/draw/' + esc(x.roundId) + '"><span><span class="t" style="display:block">' + esc(x.roundId) + '</span><span class="s">' +
            (x.winning ? "★ " + x.winning.join(" · ") + "<br/>" : "") + esc(x.winners + " winning tickets") + "</span></span>" + '<span class="chev">&#8250;</span></button>';
        }).join("") + "</div>" : '<div class="empty"><div class="e-ic">○</div><p>No draws yet — play the live round.</p></div>') +
        (serverDrawsTotal > 1 ? '<div class="apager"><button data-sdraw="-1"' + (serverDrawsPage <= 1 ? " disabled" : "") + ">← Previous</button>" +
          '<span class="apg-info">Page ' + serverDrawsPage + " of " + serverDrawsTotal + "</span>" +
          '<button data-sdraw="1"' + (serverDrawsPage >= serverDrawsTotal ? " disabled" : "") + ">Next →</button></div>" : "") +
        "</div>",
        "/", "draws"
      );
    });
  }

  function drawDetail(rid) {
    if (API_BASE) {
      if (serverDrawWinnersKey === rid && serverDrawWinners.length) {
        renderServerDrawDetail(rid);
        return;
      }
      apiGet("/api/round/" + encodeURIComponent(rid)).then(function (r) {
        if (!r || !r.ok) { toast("Draw not found"); draws(); return; }
        serverDrawWinners = r.winners || [];
        serverDrawWinning = r.winning || null;
        serverDrawWinnersKey = rid;
        serverDrawWinnersPage = 1;
        renderServerDrawDetail(rid);
      });
      return;
    }
    sweepDemo();
    var rec = roundsCache[rid] || (rid === currentRoundId() ? ensureDemoRound(rid) : finalizeDemoRound(rid));
    var winners = (rec.winners || []).slice().sort(function (a, b) { return b.matches - a.matches || (a.ticketId < b.ticketId ? -1 : 1); });
    if (drawWinnersKey !== rid) { drawWinnersKey = rid; drawWinnersPage = 1; }
    var totalPages = Math.max(1, Math.ceil(winners.length / PER_PAGE));
    if (drawWinnersPage > totalPages) drawWinnersPage = totalPages;
    if (drawWinnersPage < 1) drawWinnersPage = 1;
    var items = winners.slice((drawWinnersPage - 1) * PER_PAGE, drawWinnersPage * PER_PAGE);
    screen(
      '<div class="page fade">' +
      '<div class="sec-head"><h2 style="font-size:23px">' + esc(rid) + '</h2><span class="count">' + winners.length + " winners</span></div>" +
      '<p class="sub">All winning tickets · 20 tickets per page.</p>' +
      (rec.winning ? '<div class="balls" id="drawWinBalls"></div><button class="replay-btn" data-replay="drawWinBalls">Replay reveal</button>' : '<p class="muted small">Draw runs at ' + roundDrawTime(rid) + ", results at " + roundResultsTime(rid) + ".</p>") +
      '<div class="spacer"></div>' +
      '<p class="muted small" style="margin-bottom:10px">Green ball = matched number · grey = missed.</p>' +
      (winners.length ? '<div class="cards">' + items.map(function (w) { return winnerCard(w, rec.winning); }).join("") + "</div>" +
      winnersPagerHtml(drawWinnersPage, totalPages, "data-dwpage")
        : '<div class="empty"><div class="e-ic">○</div><p>No winning tickets yet.</p></div>') +
      "</div>",
      "/draws", "draws"
    );
    if (rec.winning) animateWinningBalls("drawWinBalls", rec.winning);
  }

  function renderServerDrawDetail(rid) {
    var totalPages = Math.max(1, Math.ceil(serverDrawWinners.length / PER_PAGE));
    if (serverDrawWinnersPage > totalPages) serverDrawWinnersPage = totalPages;
    if (serverDrawWinnersPage < 1) serverDrawWinnersPage = 1;
    var items = serverDrawWinners.slice((serverDrawWinnersPage - 1) * PER_PAGE, serverDrawWinnersPage * PER_PAGE);
    screen(
      '<div class="page fade">' +
      '<div class="sec-head"><h2 style="font-size:23px">' + esc(rid) + '</h2><span class="count">' + serverDrawWinners.length + " winners</span></div>" +
      '<p class="sub">All winning tickets · 20 tickets per page.</p>' +
      (serverDrawWinning ? '<div class="balls" id="drawWinBalls"></div><button class="replay-btn" data-replay="drawWinBalls">Replay reveal</button>' : '<p class="muted small">Draw pending.</p>') +
      '<div class="spacer"></div>' +
      '<p class="muted small" style="margin-bottom:10px">Green ball = matched number · grey = missed.</p>' +
      (serverDrawWinners.length ? '<div class="cards">' + items.map(function (w) { return winnerCard(w, serverDrawWinning); }).join("") + "</div>" +
      winnersPagerHtml(serverDrawWinnersPage, totalPages, "data-dwpage")
        : '<div class="empty"><div class="e-ic">○</div><p>No winning tickets.</p></div>') +
      "</div>",
      "/draws", "draws"
    );
    if (serverDrawWinning) animateWinningBalls("drawWinBalls", serverDrawWinning);
  }

  function tickets() {
    if (API_BASE) {
      apiGet("/api/my-tickets").then(function (r) {
        serverTickets = (r && r.ok && r.tickets) || [];
        var tp = Math.max(1, Math.ceil(serverTickets.length / PER_PAGE));
        if (serverTicketsPage > tp) serverTicketsPage = tp;
        renderServerTickets();
      });
      return;
    }
    sweepDemo();
    var list = myTickets.slice().sort(function (a, b) { return (b.ticketId < a.ticketId ? -1 : 1); });
    var totalPages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    if (ticketsPage > totalPages) ticketsPage = totalPages;
    var items = list.slice((ticketsPage - 1) * PER_PAGE, ticketsPage * PER_PAGE);
    screen(
      '<div class="page fade">' +
      '<div class="sec-head"><h2>My Tickets</h2><span class="count">' + list.length + "</span></div>" +
      '<p class="sub">Newest Tickets. 20 tickets per page.</p>' +
      (list.length ? '<div class="cards">' + items.map(function (t) {
        var rec = roundsCache[t.roundId];
        return ticketCard(t, rec && rec.winning);
      }).join("") + "</div>" +
      (totalPages > 1 ? '<div class="apager"><button data-tpage="-1"' + (ticketsPage <= 1 ? " disabled" : "") + ">← Previous</button>" +
        '<span class="apg-info">Page ' + ticketsPage + " of " + totalPages + "</span>" +
        '<button data-tpage="1"' + (ticketsPage >= totalPages ? " disabled" : "") + ">Next →</button></div>" : "")
        : '<div class="empty"><div class="e-ic">○</div><p>No tickets yet.</p><div class="spacer"></div><button class="btn-g" data-nav="/play">Play free now</button></div>') +
      "</div>",
      "/", "tickets"
    );
  }

  var serverTickets = [], serverTicketsPage = 1;
  function renderServerTickets() {
    var totalPages = Math.max(1, Math.ceil(serverTickets.length / PER_PAGE));
    if (serverTicketsPage > totalPages) serverTicketsPage = totalPages;
    if (serverTicketsPage < 1) serverTicketsPage = 1;
    var items = serverTickets.slice((serverTicketsPage - 1) * PER_PAGE, serverTicketsPage * PER_PAGE);
    screen(
      '<div class="page fade">' +
      '<div class="sec-head"><h2>My Tickets</h2><span class="count">' + serverTickets.length + "</span></div>" +
      '<p class="sub">Newest Tickets. 20 tickets per page.</p>' +
      (serverTickets.length ? '<div class="cards">' + items.map(function (t) {
        return ticketCard({ ticketId: t.ticketId, roundId: t.roundId, numbers: t.numbers, matches: t.matches, prize: t.prize, when: t.created_at, name: myName() }, t.winning);
      }).join("") + "</div>" +
      (totalPages > 1 ? '<div class="apager"><button data-stpage="-1"' + (serverTicketsPage <= 1 ? " disabled" : "") + ">← Previous</button>" +
        '<span class="apg-info">Page ' + serverTicketsPage + " of " + totalPages + "</span>" +
        '<button data-stpage="1"' + (serverTicketsPage >= totalPages ? " disabled" : "") + ">Next →</button></div>" : "")
        : '<div class="empty"><div class="e-ic">○</div><p>No tickets yet.</p><div class="spacer"></div><button class="btn-g" data-nav="/play">Play free now</button></div>') +
      "</div>",
      "/", "tickets"
    );
  }

  function wallet() {
    if (API_BASE) syncServer();
    var txList = history.slice();
    (withdrawals || []).forEach(function (w) {
      var dest = w.bank ? w.bank + " · " + (w.acctNum || "") + " · " + (w.name || "") : (w.account || "");
      txList.unshift({ what: "Withdrawal " + w.status + " · " + dest, amount: w.amount, plus: false, when: w.when });
    });
    txList.sort(function (a, b) { return String(b.when).localeCompare(String(a.when)); });
    var totalPages = Math.max(1, Math.ceil(txList.length / PER_PAGE));
    if (walletPage > totalPages) walletPage = totalPages;
    var items = txList.slice((walletPage - 1) * PER_PAGE, walletPage * PER_PAGE);
    screen(
      '<div class="page fade">' +
      '<div class="sec-head"><h2>Wallet</h2></div>' +
      '<div class="bal-card"><div class="bal-k">Mini App Balance</div><div class="bal-v">' + money(balance) + '</div><div class="bal-sub">Get 5/5 matches - win <b>' + prizeFor(5).toLocaleString("en-NG") + " naira</b>. 4/5 matches wins <b>" + prizeFor(4).toLocaleString("en-NG") + " naira</b>. 3/5 matches wins <b>" + prizeFor(3).toLocaleString("en-NG") + " naira</b>. 2/5 matches win <b>" + prizeFor(2).toLocaleString("en-NG") + " naira</b> and 1/5 matches wins <b>" + prizeFor(1).toLocaleString("en-NG") + " naira</b>.</div></div>" +
      '<div class="spacer"></div>' +
      '<div class="sec-head"><h2 style="font-size:20px">Withdraw</h2><span class="count">min ' + money(WITHDRAW_MIN) + "</span></div>" +
      '<p class="muted small" style="margin-bottom:4px">Enter the bank details where you want to receive your payout, then request.</p>' +
      '<div class="field"><input id="wdBank" maxlength="60" placeholder="Bank name (e.g. GTBank)"/><span class="cur">Bank</span></div>' +
      '<div class="field"><input id="wdAcctNum" inputmode="numeric" maxlength="20" placeholder="Account number (e.g. 0123456789)"/><span class="cur">Acct No</span></div>' +
      '<div class="field"><input id="wdName" maxlength="80" placeholder="Full name on account (e.g. Ada Obi)"/><span class="cur">Name</span></div>' +
      '<div class="field"><input id="wdAmt" type="number" inputmode="numeric" min="' + WITHDRAW_MIN + '" placeholder="Amount in NGN (min ' + WITHDRAW_MIN + ')"/><span class="cur">NGN</span></div>' +
      '<div class="spacer"></div>' +
      '<button class="btn-p" id="wdBtn">Request Withdrawal</button>' +
      '<div class="spacer"></div>' +
      '<div class="sec-head"><h2 style="font-size:20px">Activity</h2></div>' +
      (txList.length ? items.map(function (h) {
        return '<div class="tx"><div class="tx-ic">' + (h.plus ? "+" : "−") + "</div>" +
          '<div class="tx-mid"><div class="tx-t">' + esc(h.what) + '</div><div class="tx-d">' + esc(h.when) + "</div></div>" +
          '<div class="tx-a ' + (h.plus ? "pos" : "neg") + '">' + (h.plus ? "+" : "−") + money(h.amount) + "</div></div>";
      }).join("") +
      (totalPages > 1 ? '<div class="apager"><button data-wpage="-1"' + (walletPage <= 1 ? " disabled" : "") + ">← Previous</button>" +
        '<span class="apg-info">Page ' + walletPage + " of " + totalPages + "</span>" +
        '<button data-wpage="1"' + (walletPage >= totalPages ? " disabled" : "") + ">Next →</button></div>" : "")
        : '<div class="empty"><div class="e-ic">○</div><p>No activity yet — winnings will show here.</p></div>') +
      '<div class="notice"><h3>Sponsored</h3><p>Ad slot reserved here for Monetag Telegram Ads (coming soon).</p></div>' +
      "</div>",
      "/", "wallet"
    );
    el("wdBtn").addEventListener("click", function () {
      var bank = (el("wdBank").value || "").trim();
      var acctNum = (el("wdAcctNum").value || "").trim();
      var accName = (el("wdName").value || "").trim();
      var amt = parseInt(el("wdAmt").value, 10) || 0;
      if (!bank) { toast("Enter your bank name"); return; }
      if (!/^\d{6,20}$/.test(acctNum)) { toast("Enter a valid account number"); return; }
      if (!accName) { toast("Enter the full name on the account"); return; }
      if (!(amt >= WITHDRAW_MIN)) { toast("Minimum withdrawal is " + money(WITHDRAW_MIN)); return; }
      if (amt > balance) { toast("Insufficient balance"); return; }
      var dest = bank + " · " + acctNum + " · " + accName;
      if (API_BASE) {
        apiPost("/api/withdraw", { amount: amt, bank: bank, accountNumber: acctNum, accountName: accName }).then(function (r) {
          if (r && r.ok) { balance = r.balance; saveAll(); addHistory("Withdrawal request · " + dest, amt, false); saveAll(); toast("Request sent — pending payout"); wallet(); }
          else toast(r && r.error ? r.error : "Request failed");
        });
        return;
      }
      balance -= amt;
      withdrawals.unshift({ amount: amt, bank: bank, acctNum: acctNum, name: accName, status: "pending", when: new Date().toLocaleString() });
      addHistory("Withdrawal request · " + dest, amt, false);
      saveAll();
      toast("Request sent — pending payout");
      wallet();
    });
  }

  function contactAdmin() {
    var myId = tgUser && tgUser.id ? String(tgUser.id) : null;
    screen(
      '<div class="page fade">' +
      '<div class="sec-head"><h2>Contact Admin</h2></div>' +
      '<p class="sub">Contact admin for all questions, enquiries and payment support.</p>' +
      '<div class="panel">' +
      '<div class="prow"><span class="k">Telegram<small>Tap to chat</small></span><span class="v" style="font-size:17px"><a href="https://t.me/ponyed838" target="_blank" rel="noopener" style="color:var(--purple)">@ponyed838</a></span></div>' +
      (myId ? '<div class="prow"><span class="k">Your Telegram ID<small>Quote it to admin</small></span><span class="v" style="font-size:17px">' + esc(myId) + "</span></div>" : "") +
      "</div>" +
      '<div class="notice"><h3>New features coming soon</h3><p>More ways to play and win are on the way. Stay tuned.</p></div>' +
      "</div>",
      "/", ""
    );
  }

  /* ================= ROUTER ================= */
  function router() {
    sweepDemo();
    var seg = (location.hash || "").replace(/^#/, "") || "/";
    var parts = seg.split("/").filter(function (p) { return p.length > 0; });
    if (parts.length === 0) { welcome(); return; }
    if (parts[0] === "play") { play(); return; }
    if (parts[0] === "how") { howToUse(); return; }
    if (parts[0] === "rules") { rules(); return; }
    if (parts[0] === "draws") { draws(); return; }
    if (parts[0] === "draw" && parts[1]) { drawDetail(decodeURIComponent(parts[1])); return; }
    if (parts[0] === "tickets") { tickets(); return; }
    if (parts[0] === "contact") { contactAdmin(); return; }
    if (parts[0] === "wallet") { wallet(); return; }
    welcome();
  }

  /* Live countdown (updates [data-cd] every second + auto-refresh on boundaries) */
  var lastMin = -1;
  function tick() {
    var spans = document.querySelectorAll("[data-cd]");
    if (spans.length) {
      var ms = msToNextBoundary(Date.now());
      for (var i = 0; i < spans.length; i++) spans[i].textContent = fmtCountdown(ms);
    }
  }
  setInterval(function () {
    tick();
    var m = lagosParts(Date.now()).mi;
    if (m !== lastMin) {
      lastMin = m;
      /* Re-render on window edges so OPEN→DRAWING→RESULTS flips live */
      if (m === 51 || m === 52 || m === 0) router();
      if (API_BASE && (m % 1 === 0)) syncServer();
    }
  }, 1000);

  /* ================= EVENTS ================= */
  document.addEventListener("click", function (e) {
    var t = e.target;
    var nav = t.closest ? t.closest("[data-nav]") : null;
    if (nav) { e.preventDefault(); location.hash = "#" + nav.getAttribute("data-nav"); return; }
    var rp = t.closest ? t.closest("[data-replay]") : null;
    if (rp) {
      var bid = rp.getAttribute("data-replay");
      if (bid && revealData[bid]) animateWinningBalls(bid, revealData[bid]);
      return;
    }
    function pager(attr, cb) {
      var b = t.closest ? t.closest("[" + attr + "]") : null;
      if (b && !b.disabled) {
        var d = parseInt(b.getAttribute(attr), 10) || 0;
        cb(d);
        var y = window.scrollY || 0;
        router();
        window.scrollTo(0, y);
        return true;
      }
      return false;
    }
    if (pager("data-dpage", function (d) { drawsPage += d; })) return;
    if (pager("data-tpage", function (d) { ticketsPage += d; })) return;
    var stp = t.closest ? t.closest("[data-stpage]") : null;
    if (stp && !stp.disabled) {
      serverTicketsPage += parseInt(stp.getAttribute("data-stpage"), 10) || 0;
      renderServerTickets();
      return;
    }
    var dwp = t.closest ? t.closest("[data-dwpage]") : null;
    if (dwp && !dwp.disabled) {
      var dd = parseInt(dwp.getAttribute("data-dwpage"), 10) || 0;
      if (API_BASE) {
        serverDrawWinnersPage += dd;
        renderServerDrawDetail(serverDrawWinnersKey);
      } else {
        drawWinnersPage += dd;
        var y3 = window.scrollY || 0;
        router();
        window.scrollTo(0, y3);
      }
      return;
    }
    if (pager("data-wpage", function (d) { walletPage += d; })) return;
    if (t.closest && t.closest("[data-sdraw]") && !t.closest("[data-sdraw]").disabled) {
      var d = parseInt(t.closest("[data-sdraw]").getAttribute("data-sdraw"), 10) || 0;
      (function (page) {
        fetch(API_BASE + "/api/rounds?page=" + page + "&" + apiQS(), { cache: "no-store" })
          .then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (r) {
            if (r && r.ok) { serverDraws = r.rounds || []; serverDrawsPage = r.page || page; serverDrawsTotal = r.totalPages || 1; drawsServerCached(); }
          }).catch(function () {});
      })(serverDrawsPage + d);
      return;
    }
  });
  function drawsServerCached() {
    screen(
      '<div class="page fade">' +
      '<div class="sec-head"><h2>Previous Draws</h2><span class="count">live</span></div>' +
      '<p class="sub">Tap a draw for winning numbers + all winners from 5/5 matches to 1/5 matches.</p>' +
      (serverDraws.length ? '<div class="rows">' + serverDraws.map(function (x) {
        return '<button class="row-card" data-nav="/draw/' + esc(x.roundId) + '"><span><span class="t" style="display:block">' + esc(x.roundId) + '</span><span class="s">' +
          (x.winning ? "★ " + x.winning.join(" · ") + "<br/>" : "") + esc(x.winners + " winning tickets") + "</span></span>" + '<span class="chev">&#8250;</span></button>';
      }).join("") + "</div>" : '<div class="empty"><div class="e-ic">○</div><p>No draws yet.</p></div>') +
      (serverDrawsTotal > 1 ? '<div class="apager"><button data-sdraw="-1"' + (serverDrawsPage <= 1 ? " disabled" : "") + ">← Previous</button>" +
        '<span class="apg-info">Page ' + serverDrawsPage + " of " + serverDrawsTotal + "</span>" +
        '<button data-sdraw="1"' + (serverDrawsPage >= serverDrawsTotal ? " disabled" : "") + ">Next →</button></div>" : "") +
      "</div>",
      "/", "draws"
    );
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && el("enterBtn") && document.activeElement && document.activeElement.className.indexOf("slot") !== -1) {
      el("enterBtn").click();
    }
  });

  function loadScript(src, onload) {
    var s = document.createElement("script");
    s.src = src;
    s.async = true;
    if (onload) { s.onload = onload; s.onerror = function () {}; }
    document.head.appendChild(s);
  }

  window.addEventListener("hashchange", router);
  loadScript("https://telegram.org/js/telegram-web-app.js", initTelegram);
  lastMin = lagosParts(Date.now()).mi;
  router();
  syncServer();
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { sweepDemo(); syncServer(); router(); } });
  window.addEventListener("focus", function () { sweepDemo(); syncServer(); });

  /* Expose engine for debugging / tests */
  window.LOTTO = {
    roundIdFor: roundIdFor, roundHourStart: roundHourStart, roundStatusAt: roundStatusAt,
    seededDraw: seededDraw, countMatches: countMatches, prizeFor: prizeFor,
    makeTicketId: makeTicketId, validPick: validPick, lagosParts: lagosParts,
    fmtLagosTime: fmtLagosTime, roundCloseTime: roundCloseTime,
  };
})();
