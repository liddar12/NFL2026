# RCA 2026-10-08: prod stopped deploying (Netlify team credits exhausted)

## Summary

From 2026-10-06 13:15Z until 2026-10-08 03:09Z, Netlify skipped every production deploy of
main. The site kept serving, but it served the 13:15Z build of Oct 6 for almost 38 hours.
13 commits to main never reached prod. Two of them were code changes:

- R117 (#149), merged Oct 6 17:49Z, went live about 33 hours late.
- R118 (#153), merged Oct 7 22:46Z, went live about 4.4 hours late.

The root cause was the account, not the repo. The team's Netlify plan bills every
production deploy against a shared monthly credit pool. This project alone publishes
more deploys than the pool covers. When the pool ran out, Netlify paused production
deploys for every site on the team. Nothing in the pipeline, the build or the repo
config was at fault.

## Timeline (UTC)

| When | What |
|---|---|
| Sep 20 | The billing cycle starts: 3,000 credits shared by 16 team projects. |
| Sep 29 | Netlify email: 50% of credits used. |
| Oct 3 | Netlify email: 75% of credits used. |
| Oct 6 13:15:45 | ef824671 (daily refresh) is the last production deploy that publishes. |
| Oct 6 13:21:35 | Netlify email: "used all available credits". Production deploys are paused; previews, branch deploys and the live site carry on. |
| Oct 6 16:45 – Oct 8 01:50 | 13 commits on main all show "Skipped due to account credit usage exceeded". These include R117, R117 follow-up (#151) and R118. |
| Oct 6 22:16 onward | The freshness checks report prod as stale, but they can't see why. |
| Oct 8 03:01:41 | The owner buys a credit pack (1,500 credits for $10). |
| Oct 8 03:04 | Daily run #269 is dispatched to produce a fresh commit. |
| Oct 8 03:09:30 | 7431d256 publishes (deploy 6ac70959…, not skipped). Prod is verified current: R117 and R118 code live, all stages ok. |
| Oct 8 03:13 | Netlify email: "reached 50% of your 3000 credit allowance". The alert fired again after the purchase; the team usage page is authoritative. |

## Root cause

**The credit model.** On the credit-based Pro plan, each production deploy costs 15
credits. Deploy Previews cost nothing.

**The volume.** Every pipeline publish (scripts/publish_data.sh) is a commit to main,
and each one is a production deploy. The `[skip actions]` marker stops GitHub Actions
from re-running; it does not stop Netlify. The deploy counts for this project alone:

| Window | Production deploys | Credits |
|---|---|---|
| September | 250 | about 3,750 |
| Sep 20 – Oct 6 | 193 | about 2,895 |
| 30 days before the cutoff | 283 | about 4,245 |

The 283 deploys break down as:

| Source | Deploys |
|---|---|
| daily | 155 |
| gameday | 53 |
| backtest | 12 |
| PR merges | 58 |
| other | 5 |

Production deploys aren't the only meter: bandwidth, web requests and function compute
also draw on the pool, and so do the other 15 projects.

**The gap.** At about 4,000 credits a month, this project alone needs more than the
3,000-credit pool that 16 projects share. Running out mid-cycle is structural: it will
happen every cycle unless credits are bought or volume falls.

## Contributing factors

- **The schedulers overlap.** daily.yml has its own crons: morning, evening, and
  pre-kickoff on Sunday, Monday and Thursday. The scheduled routines also dispatch daily
  at about the same times, because GitHub throttles crons. Over the 30 days that gives
  89 manual daily dispatches against 75 cron runs.
- **Fix-forward re-dispatches.** Each data-ci repair (R113 to R118) ended with a merge
  plus one or more re-dispatches. That added roughly 16 deploys a week during the fixes.
- **Almost every run commits something.** Only 1 of the last 223 bot commits was
  status-only. Each one carries fresh timestamps, so nearly every run is a full deploy.

## Why detection lagged (about 9 hours to flag, about 38 hours to fix)

- **Freshness was flagged, the cause was not.** The routine check (`updated_utc` within
  40 minutes) flagged stale prod from Oct 6 22:16Z. But the skip reason appears only in
  the Netlify UI, the billing emails and the team usage page.
- **No visible signal in the tools.** Netlify posts no commit status on this repo. The
  Netlify connector can read a deploy by its id, but it can't list deploys or show
  usage.
- **Plausible look-alikes.** The symptom matched causes that had been seen before. The
  investigation ruled those out before the inbox evidence and the owner's screenshot
  of Activity closed the gap.

## Ruled out

- **Build config.** There is no `ignore` command in netlify.toml. Skip keywords
  (`[skip ci]`, `[skip netlify]`) appear on no affected commit. No build was stopped and
  no deploy was locked.
- **Platform.** No Netlify platform incident was reported in the window.
- **Pipeline.** Every affected commit published cleanly to main and passed data-ci.

## Recurrence

This is the third exhaustion in three cycles:

- **Jun 29.** The pool ran out.
- **Aug 4.** The pool ran out again.
- **July cycle.** Five full project suspensions (Jul 3, 8, 11, 15 and 18) once the
  300-credit operational allowance was also spent. Those took sites offline, not just
  their deploys.

Ten $10 credit packs have been bought since Jun 9. With auto recharge off, each cycle
ends the same way: deploys pause until someone notices and tops up by hand.

## Fix applied

- **Credits.** The owner bought a 1,500-credit pack on Oct 8 at 03:01Z.
- **Verification.** A fresh daily dispatch published at 03:09:30Z, and the deploy was
  not skipped. Prod was then checked against the expected state:
  - player_weekly 03:05:35Z, week 5, 31 players gated;
  - R100 live layer present;
  - R117 band and R118 traded-player grading live;
  - pipeline_stages all ok.

## Prevention (decision pending with the owner)

1. **Turn on auto recharge (recommended, owner-only).** In Netlify, go to Team → Usage &
   billing (https://app.netlify.com/teams/liddar12/billing/general) → Configure auto
   recharge and set it to Enabled. Each recharge is 1,500
   credits for $10. This closes both failure modes: paused deploys and full-site
   suspension. At current volume it costs about $10–25 a month, which is what the
   manual packs already cost.
2. **Cut deploy volume.** Possible changes:
   - Have the routines skip a daily dispatch when a cron run succeeded in the last hour.
   - Batch re-dispatches during fix-forward.
   - Mark low-value publishes `[skip netlify]`.

   This saves about $0.10 per deploy avoided, at some cost to freshness.
3. **Name the cause when prod is stale.** When the freshness check finds prod behind
   main, check credit usage first: the Netlify "used all available credits" email in
   the inbox, then Team → Usage & billing. A pipeline-side watchdog could also compare
   prod against the last published commit and open an issue.
