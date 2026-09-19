/* Engine self-test: node test.js (no DB needed for engine checks). */
const S = require("./server.js");

let fails = 0;
function ok(name, cond, extra) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : ""));
  if (!cond) fails++;
}

/* Round IDs */
const tsA = Date.UTC(2026, 8, 18, 0, 15) - 3600000 + 3600000; // placeholder, use lagosParts below
ok("letter A is 00:00-01:00 Lagos", S.roundIdFor(Date.UTC(2026, 8, 17, 23, 15)) === "NG18092026A", S.roundIdFor(Date.UTC(2026, 8, 17, 23, 15)));
ok("round example NG18092026A", S.roundIdFor(Date.UTC(2026, 8, 17, 23, 15)) === "NG18092026A");
ok("hour B", S.roundIdFor(Date.UTC(2026, 8, 18, 0, 30)) === "NG18092026B", S.roundIdFor(Date.UTC(2026, 8, 18, 0, 30)));
ok("hour X (23:00 Lagos)", S.roundIdFor(Date.UTC(2026, 8, 18, 22, 5)) === "NG18092026X", S.roundIdFor(Date.UTC(2026, 8, 18, 22, 5)));

/* Statuses */
const openTs = Date.UTC(2026, 8, 18, 10, 20); // 11:20 Lagos
ok("OPEN at :20", S.roundStatusAt(openTs) === "OPEN");
ok("DRAWING at :51", S.roundStatusAt(Date.UTC(2026, 8, 18, 10, 51)) === "DRAWING");
ok("RESULTS at :55", S.roundStatusAt(Date.UTC(2026, 8, 18, 10, 55)) === "RESULTS");

/* Seeded draw: deterministic, 5 unique 1-100, no Math.random */
const d1 = S.seededDraw("NG18092026A");
const d2 = S.seededDraw("NG18092026A");
ok("draw deterministic", JSON.stringify(d1) === JSON.stringify(d2), d1);
ok("draw 5 unique 1-100", d1.length === 5 && new Set(d1).size === 5 && d1.every((n) => n >= 1 && n <= 100), d1);
ok("draw sorted", d1.slice().sort((a, b) => a - b).join() === d1.join());
ok("different rounds differ (likely)", JSON.stringify(S.seededDraw("NG18092026A")) !== JSON.stringify(S.seededDraw("NG18092026B")));

/* Matches + prizes */
ok("matches count", S.countMatches([1, 2, 3, 4, 5], [3, 4, 5, 6, 7]) === 3);
ok("prize 1=1", S.prizeFor(1) === 1);
ok("prize 2=50", S.prizeFor(2) === 50);
ok("prize 3=100", S.prizeFor(3) === 100);
ok("prize 4=500", S.prizeFor(4) === 500);
ok("prize 5=10000", S.prizeFor(5) === 10000);

/* Ticket format: roundId + 10 digits */
const tid = S.makeTicketId("NG18092026A", 564575);
ok("ticket format", tid === "NG18092026A0000564575", tid);
ok("ticket serial padded 10", /^NG\d{8}[A-X]\d{10}$/.test(S.makeTicketId("NG18092026A", 1)));

/* Validation */
ok("valid pick ok", S.validPick([5, 12, 33, 77, 100]) === true);
ok("reject dupes", S.validPick([5, 5, 33, 77, 100]) === false);
ok("reject out of range", S.validPick([0, 12, 33, 77, 100]) === false);
ok("reject 101", S.validPick([1, 2, 3, 4, 101]) === false);
ok("reject 4 nums", S.validPick([1, 2, 3, 4]) === false);

console.log(fails === 0 ? "\nALL TESTS PASSED" : "\n" + fails + " TEST(S) FAILED");
process.exit(fails === 0 ? 0 : 1);
