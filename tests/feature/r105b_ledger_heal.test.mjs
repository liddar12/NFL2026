/* R105b — THE ESTIMATE LEDGER HEALS ITSELF, AND ITS LOCKS OBEY ONE RULE.
 *
 * R103 made the ledger append-only and restored the 25 players it had deleted,
 * but 18 players who were dropped and LATER RE-ADDED (pre-R103, the builder made
 * them a new record) had lost 19 locked week estimates and their true first
 * sight. Owner, 2026-10-01: "figure out an ongoing solution". So:
 *
 *  * the builder records a returning player's absence as a gap and locks no
 *    week from his stale pre-absence estimate (a latent defect of append-only);
 *  * scripts/restore_ledger_players.py runs on every daily pipeline and restores,
 *    from the ledger file's own git history, every lock / first sight / record a
 *    committed version ever held — verbatim, marked `recovered`, idempotent;
 *  * one rule (build_estimate_ledger.lock_eligible) says exactly which weeks a
 *    player must hold a lock for; the committed ledger must match it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const py = (body) => JSON.parse(execFileSync('python3', ['-'], {
  cwd: ROOT, encoding: 'utf8', input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
}).trim().split('\n').pop());

test('the builder and the heal selftests pass (gap + no stale lock; verbatim, idempotent heal)', () => {
  for (const s of ['scripts/build_estimate_ledger.py', 'scripts/restore_ledger_players.py']) {
    execFileSync('python3', [s, '--selftest'], { cwd: ROOT, stdio: 'pipe' });
  }
});

test('the committed ledger holds exactly the locks the lock rule owes — none missing, none extra', () => {
  const r = py(`
from scripts import build_estimate_ledger as bl
doc = json.load(open("data/estimates/2026.json"))
kick = bl.kickoffs_by_week(json.load(open("data/schedule_full.json"))["games"])
v = bl.lock_violations(doc, kick)
print(json.dumps({"n": len(v), "sample": v[:5],
  "locks": sum(len(p["locked"]) for p in doc["players"].values())}))`);
  assert.ok(r.locks > 0, 'the ledger holds locks — the rule is exercised');
  assert.equal(r.n, 0, `lock rule violations: ${JSON.stringify(r.sample)}`);
});

test('healing the committed ledger over its own history keeps the rule and is idempotent', () => {
  const r = py(`
from scripts import build_estimate_ledger as bl, restore_ledger_players as R
cur = json.load(open("data/estimates/2026.json"))
hist = R.history("data/estimates/2026.json")      # a shallow clone has little: still sound
kick = bl.kickoffs_by_week(json.load(open("data/schedule_full.json"))["games"])
doc, rest = R.restore(cur, hist)
again, rest2 = R.restore(doc, hist)
lost = sum(1 for _, d in hist for pid, p in (d.get("players") or {}).items()
           for wk in (p.get("locked") or {}) if wk not in (doc["players"].get(pid) or {}).get("locked", {}))
print(json.dumps({"violations": len(bl.lock_violations(doc, kick)), "idempotent": again == doc,
                  "second": len(rest2), "lost_after_heal": lost}))`);
  assert.equal(r.violations, 0, 'a healed ledger still obeys the lock rule');
  assert.equal(r.lost_after_heal, 0, 'no lock any committed version held is missing after the heal');
  assert.equal(r.idempotent, true);
  assert.equal(r.second, 0, 'a healed ledger heals to itself');
});

test('the race-safe merge keeps every gap and every recovered week from both writers', () => {
  const r = py(`
from scripts.merge_ledgers import merge_player, SHAPES
g1 = {"last_seen": "2026-09-12T06:00:00Z", "back": "2026-09-26T06:00:00Z"}
g2 = {"last_seen": "2026-10-02T06:00:00Z", "back": "2026-10-05T06:00:00Z"}
base = {"name": "P", "first": {"as_of_utc": "a"}, "latest": {"as_of_utc": "a"}, "locked": {}}
t = dict(base, gaps=[g1], recovered={"locked_weeks": [1], "first": True, "source": "s"})
o = dict(base, gaps=[g2, g1], recovered={"locked_weeks": [2], "first": False, "source": "s"})
m = merge_player(base, t, o, SHAPES[0]["entries"])
print(json.dumps({"gaps": m["gaps"], "rec": m["recovered"]}))`);
  assert.equal(r.gaps.length, 2, 'both absences, once each');
  assert.equal(r.gaps[0].last_seen, '2026-09-12T06:00:00Z', 'in order');
  assert.deepEqual(r.rec, { locked_weeks: [1, 2], first: true, source: 's' });
});
