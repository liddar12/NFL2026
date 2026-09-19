# Publishing data/ to main (R88)

One page answering one question: **how does a pipeline run get its generation onto
`main` when it is not the only writer?**

Written for [F16](qa/CODEX_REVIEW_R82_FOR_CLAUDE.md) — *"The 'race-safe' Git push loop
cannot recover from divergence."* Every workflow used to end with `git pull` in
fast-forward-only mode followed by `git push`, five times. That works only while we
are the sole writer. `daily` and `backtest` share the `data-pipeline` concurrency
group but `gameday` has its own, so two pipeline runs can hold commits from the same
base; the owner can also land code on `main` at any moment. Once both sides have a
commit, a fast-forward pull is impossible *by definition* and repeating it cannot
change that — the run burned five tries and threw a good, validated generation away
with exit 1.

`scripts/publish_data.sh` replaces that loop. Same call site, one line:

```yaml
- name: Commit data/
  run: bash scripts/publish_data.sh "data: daily pipeline refresh [skip actions]"
```

## The algorithm

1. Configure the bot identity, `git add data/`. Nothing staged → `No data changes to
   commit.`, exit 0. Otherwise **one** commit, with the workflow's own message.
2. Up to **5 attempts**:
   1. `git fetch origin main`.
   2. Fetched head is an ancestor of `HEAD` → `git push origin HEAD:main`. Pushed →
      exit 0.
   3. Otherwise `main` moved: **re-create this run's data commit on the new head**
      with `git rebase`. Every conflicted path is resolved by the rules below, with
      no interactive step and no prompt.
   4. The merged tree must pass the contract gate (`python3 scripts/validate_data.py`)
      **while the rebase can still be abandoned**. It fails → `git rebase --abort`,
      one `::error::` line, exit 1. A document that fails validation is never
      published, however much work produced it. A rebase that produced no conflict
      at all is gated too, after the fact: every file is then wholly one side's, but
      the contracts also check joins *across* files, and this run's documents have
      never been seen beside the other writer's.
   5. Push. Rejected because someone landed between the fetch and the push → log the
      reason, sleep 5 s, next attempt.
3. Out of attempts → one `::error::` line and exit 1. The generation is still
   committed in the runner's checkout and `main` is intact; nothing was lost, it was
   simply not published.

It never rewrites the remote — no forced push, with or without a lease — and never
resets another writer's commit. The only history it rewrites is the local commit it
created itself.

## Which side wins a conflicted path

During a rebase the stage numbers do **not** mean what they mean in a merge, and
getting them backwards would publish the other run's output under this run's name:

| stage | `git show` | what it is |
|---|---|---|
| 1 | `:1:path` | the merge base — the commit both runs started from |
| 2 | `:2:path` | **the new head** we are replaying onto (the other writer) |
| 3 | `:3:path` | **ours** — the commit being replayed, i.e. this run's generation |

| path | rule | why |
|---|---|---|
| an append-only ledger (table below) | merged **by identity** with `scripts/merge_ledgers.py` from all three stages | both writers' entries are real records; taking either whole side is exactly the data loss F16 warns about |
| anything else under `data/` | **ours** (stage 3) | this run just rebuilt it from the newest inputs, so ours is the newest valid version |
| `data/snapshots/*` | ours (stage 3), and the path is named in the log | snapshots are immutable point-in-time files graded in place from FINAL scores; two runs grading one snapshot should produce identical bytes, so a conflict there is worth seeing |
| anything outside `data/` | **abort, exit 1** | a pipeline commit touches no code, so a code collision is not something an automatic rule should paper over |

## The ledger identity table

`scripts/merge_ledgers.py` merges these and refuses everything else. The identity key
is the ledger's own — the same key its builder uses to decide whether an entry is new.

| file | entries | identity key | first sight | runs / history | order |
|---|---|---|---|---|---|
| `data/estimates/<season>.json` | `players{}` | the player id (the map key) | `first.as_of_utc` | `runs[]` by `as_of_utc` | oldest first |
| `data/estimates/parlays_<season>.json` | `legs[]` | `(season, week, game_id, market, selection)` | `seen_utc` | `runs[]` by `as_of_utc` | oldest first |
| `data/my_cards/<season>_wk<NN>.json` | `cards[]` | `card_id` (sha1 of dial + seed + sorted selections) | `first_seen_utc` | `runs[]` by `pool_generated_utc` | oldest first |
| `data/parlays/<season>_wk<NN>.json` | — | — | — | `history[]` by `updated_utc` | oldest first |
| `data/model_tuning.json` | — | — | — | `history[]` by `(generated_utc, kind)` | **newest first** |

`data/parlays/index.json` is deliberately absent: it is rebuilt from the per-week
archives every run, so it is regenerable like everything else.

Merge rules, per shape:

* **Union by identity.** An entry present on either side is present in the result.
  Nothing is ever dropped.
* **Same key on both sides → the EARLIER first sight wins**, because first sight is
  what locks the as-made numbers. Which *side* that is does not matter.
* **One side changed an entry the other left exactly as the base had it → the changed
  side**, so a resolver filling graded fields, or `latest` advancing, survives.
* **Both changed the same field → the earlier-first-sight side's value.** In the
  player ledger the parts are governed separately: `first` keeps the earlier as-of,
  `latest` takes the later, `locked` is a per-week union where the earlier as-of wins.
* **`runs[]` / `history[]`: union by key.** A record already in the base is never
  rewritten. New records are placed where that file's writer puts them (at the end,
  or at the front for `model_tuning`), so rows nobody touched are never reordered —
  a merge of a file with itself is byte-for-byte the identity.
* **Header scalars** (`generated_utc`, `as_of_utc`, `updated_utc`, counts) take the
  **later** as-of: the header describes the newest generation in the merged file.
  `closed` on a week archive only ever goes false → true.

Output is written exactly the way each ledger's own writer writes it — `indent=2`
with a trailing newline, and compact for `data/estimates/<season>.json`, whose
builder writes it compact on purpose — so a raced commit carries no cosmetic churn.

Every value in a merged file comes from one of the three inputs. Nothing is averaged,
interpolated or invented.

## What still cannot be merged

* **A conflict outside `data/`.** Exit 1 with the path named. Re-run the workflow once
  `main` is settled, or resolve it by hand.
* **An unknown ledger shape.** `merge_ledgers.py` exits 2 and the publish fails hard.
  Adding a new append-only ledger means adding it to the shape registry in that script
  *and* to `is_ledger()` in `publish_data.sh`; until then a conflict on it fails loudly
  rather than resolving to one side by guesswork.
* **`data/snapshots/`.** Refused by name: each snapshot is its own immutable file, so
  two writers cannot legitimately both edit one.
* **More than 5 attempts.** The bound is deliberate. A `main` that is being written
  faster than a run can rebase onto it is an operational problem, not something to
  retry forever inside a job.

## Checks

```
python3 scripts/merge_ledgers.py --selftest      # every shape, both refusals, on-disk form
bash -n scripts/publish_data.sh
node --test tests/feature/r88_publish_race.test.mjs
```

`tests/feature/r88_publish_race.test.mjs` builds a real bare remote and two real
clones in a temporary directory (never this repository) and races them: a clean push,
two generations from a common base, an owner code push landing mid-run, the same leg
key appended on both sides with different first sights (both directions), a contract
gate that refuses the merged tree, and a remote that rejects every push. It substitutes
a trivial validator through `PUBLISH_VALIDATE_CMD` and asserts that the **default** is
the real `python3 scripts/validate_data.py`.

Env seams, all defaulted to what production runs: `PUBLISH_VALIDATE_CMD`,
`PUBLISH_BACKOFF_S` (5), `PUBLISH_ATTEMPTS` (5).
