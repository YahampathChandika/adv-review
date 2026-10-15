# Calibration

How well does the review find what is there, and how much does it report that is not?
This directory measures that against a fixture with known defects.

- **The fixture**: [adv-review-calibration](https://github.com/YahampathChandika/adv-review-calibration),
  a small ledger service (accounts, transfers, a JSON store with migrations, bearer
  tokens, an audit log, CSV export, daily interest, outgoing webhooks, a read cache; no
  dependencies). Its `main` is meant to be clean. Each pull request adds a feature in the
  ordinary way; most carry one planted defect that the PR's own tests do not catch, and
  four carry none. There are two sets:
  - **v1**, PRs #1 to #11: ten defects across the eight generic angles, on the service
    before interest, webhooks and the cache. Each can be seen in the changed lines with
    care.
  - **v2**, PRs #12 to #21: eight harder defects on the grown service. Each needs more
    than the changed lines: an interleaving at an `await`, a writer in another file, a
    time zone, a second user, a rule written in `docs/`.
- **The answer key**: `manifest.json`. One entry per planted defect: the branch and PR,
  the angle it is meant to trip, severity, what is wrong, a concrete failure, and the
  file and lines at the branch head. Plus the clean PRs, and `known` defects on `main`
  that a review may fairly report. The key lives here, not in the fixture, because the
  review's agents read the whole repository at the PR's head.
- **The scorer**: `score.mjs`. It reads results written by the review's `--out` option
  and says, per PR, which planted defects were confirmed, which were found and then
  wrongly refuted, which were missed, and which confirmed findings match nothing
  planted; and over the set, recall and precision.

## The planted defects

| | PR | Angle | Severity | What |
| :- | :- | :- | :- | :- |
| D1 | #1 Page the transfer history | correctness | high | every page drops its 20th item |
| D2 | #2 Refuse control characters in memos | tests-that-dont-test | medium | the test cannot fail; the code alters the memo instead of refusing it |
| D3 | #3 openAccount takes the acting user | boundary-contract | medium | the seed script still calls the old signature |
| D4 | #4 Overdraft limits | silent-drops | high | the new key is not in `SCHEMA`, so the store strips it |
| D5 | #5 Accountant role | authz-and-attribution | high | the relaxed helper also lets an accountant close and export any account |
| D6 | #6 Transfer on a member's behalf | authz-and-attribution | high | the admin's act is recorded as the member's |
| D7 | #7 Named exports | security | high | the file name is joined into the path unchecked |
| D8 | #7 Named exports | security | medium | failed sign-ins log the bearer token |
| D9 | #8 Withdrawals and a summary | data-integrity | medium | withdrawals never update the running totals |
| D10 | #9 Store the label as name | migrations-and-rollout | high | the rename deletes the old key in the same migration |

Two PRs, #10 *Audit trail per account* and #11 *Export: a currency column*, are clean. A
finding on them is a false positive until a person says otherwise.

| | PR | Angle | Severity | What |
| :- | :- | :- | :- | :- |
| D11 | #12 Screen large transfers | data-integrity | high | an `await` between the funds check and the debit lets concurrent transfers overdraw |
| D12 | #13 Cache the account list | data-integrity | medium | the cache is cleared by transfers and deposits only; opening, closing and interest leave it stale |
| D13 | #14 Accrue interest hourly | correctness | high | the once-a-day guard compares a local day with a UTC day, so interest is credited every hour for part of each day |
| D14 | #15 Idempotency keys | authz-and-attribution | high | keys are global, so one user's key returns another user's transfer |
| D15 | #16 Owners' account webhooks | security | high | the server requests any URL a member supplies |
| D16 | #17 Call the memo a note | migrations-and-rollout | medium | the new readers ignore the old key, so transfers written mid-rollout lose their memo |
| D17 | #18 Round interest to the cent | correctness | medium | rounds to a hundredth of a cent, so balances stop being whole cents |
| D18 | #19 Members can freeze an account | authz-and-attribution | high | the freeze webhook goes out before the ownership check |

Two v2 PRs, #20 *Show each account's interest rate* and #21 *Webhooks: a delivery id*,
are clean.

Every planted defect is shown to bite on its branch before it enters the key.
`verify/verify.mjs` does it, from a clone of the fixture:

```
node calibration/verify/verify.mjs ../adv-review-calibration            # every branch in the key
node calibration/verify/verify.mjs ../adv-review-calibration feat/freeze-account
```

It checks out each branch, and its merge base with main, into temporary worktrees
outside the clone, runs the branch's own code, and prints what each defect does. It
lives here, not in the fixture, so the reviewing agents cannot read it.

## Run a pass

`run.sh` runs one headless review per PR from a clone of the fixture and writes each
result where the scorer reads it. Clone the fixture, sign `gh` in to github.com, then:

```
calibration/run.sh ../adv-review-calibration calibration/results/<version> $(seq 1 21)
```

`MODEL` picks the agents' model (default `sonnet`, which the published numbers use;
`MODEL=opus` for the default users get) and `SESSION_MODEL` the orchestrating session's
(default `opus`). For two lanes, run it twice with disjoint PR
lists in two separate clones; one clone cannot host two sessions at once. A review
takes 15 to 30 minutes on the fixture. The session runs in permission mode `auto`,
which approves what the review needs and refuses the rest.

Results are kept per version under `results/`, so passes are comparable. Then:

```
node calibration/score.mjs                # the newest results/<version>/
node calibration/score.mjs --results calibration/results/0.2.0
node calibration/score.mjs --set v2          # one set only
node calibration/score.mjs --min-recall 0.7   # exit 1 below the bar, for CI
node calibration/score.mjs --json         # the rows and the summary as JSON
```

The scorer asks `gh` for each PR's current head and skips a result for any other
commit, so stale results never count; `--offline` skips that check. A confirmed finding
matches a planted defect when one of its sites is in the same file within five lines
(`--window`) of the defect's.

A finding the review marks pre-existing (on the base commit, not introduced by the PR)
is listed and left out of precision: the planted defects are all introduced by their
PR, and a true finding about `main` is not a false positive. What remains unmatched is
listed under *to adjudicate* and counts as false until a person rules on it: a true
finding about `main` goes into `known`; a true finding about the PR that nobody
planted, or a false one, goes into `adjudicated` with its PR, site and `truth`, and
the reasoning in `note`. A ruling on a finding's own site outranks a planted line among
its grouped sites; a ruling whose lines contain the finding's line outranks one that is
merely within the window; and a ruling with `finding`, a regular expression, applies
only to findings whose title matches it and outranks one without at the same place, so
two findings on one line can be ruled apart. Unknown is not true, so an unadjudicated
finding lowers precision.

## Other agents

`bench.sh` runs a sample of the fixture through the standalone runner for one agent at a
time, from a terminal:

```
calibration/bench.sh ../adv-review-calibration claude        # Claude agents; MODEL=sonnet for comparability
calibration/bench.sh ../adv-review-calibration codex         # the Codex CLI's default model
calibration/bench.sh ../adv-review-calibration gemini
calibration/bench.sh ../adv-review-calibration copilot
```

`MODEL`, `JOBS` and `MAX_MIN` work as for `run.sh`; `EXTRA` adds runner flags, and
defaults to `--network` for Codex, whose sandbox otherwise blocks the listening socket
the fixture's HTTP tests open.

The default sample is PRs #4, #7, #14 and #11: two planted defects from the first set,
one from the second, and a clean PR. Results land in `results/0.5.0-<agent>/`, which the
scorer's default skips (it is not a bare version), so score them explicitly:

```
node calibration/score.mjs --results calibration/results/0.5.0-codex
```

Each result carries a `runner` block naming the agent, the model the CLI reported, the
CLI version, every call with its duration and cost, and the elapsed time. A sample this
small is indicative, not a score; it shows whether the review works at all with that
agent and roughly what it costs. `bench-table.mjs` turns result folders into the
Markdown table the README carries, one row per PR with the verdict and what it spent;
for a plugin-path folder it reads the cost from the session log beside each result:

```
node calibration/bench-table.mjs --results calibration/results/0.4.0 --results calibration/results/0.5.0-codex
```

### The 0.5.0 sample

Recorded 15 October 2026: Claude agents on Sonnet, six at once, and Codex on its CLI's
default model, three at once, each CLI at its default settings, next to the 0.4.0 plugin
pass (Sonnet agents) on the same PRs. Minutes are wall-clock per PR. The plugin's
dollars are the session's `total_cost_usd`, which includes the Opus session that ran the
review; the runner's are the agents' alone, and Codex reports tokens, not dollars.

**0.4.0**: plugin path, Sonnet agents

| PR | Planted | Other confirmed findings | Agents | Calls | Minutes | Cost |
| :- | :- | :- | -: | -: | -: | :- |
| #4 | D4 ✓ | — | 12 | — | 23 | $5.51 |
| #7 | D7 ✓, D8 ✓ | — | 20 | — | 19 | $5.77 |
| #11 | clean; none reported | — | 4 | — | 17 | $2.47 |
| #14 | D13 ✓ | 2 true | 18 | — | 34 | $9.15 |

**0.5.0-claude**: claude agents on claude-sonnet-5 (2.1.267 (Claude Code), 6 at once)

| PR | Planted | Other confirmed findings | Agents | Calls | Minutes | Cost |
| :- | :- | :- | -: | -: | -: | :- |
| #4 | D4 ✓ | — | 10 | 10 | 16 | $3.02 |
| #7 | D7 ✓, D8 ✓ | — | 19 | 19 | 15 | $3.94 |
| #11 | clean; none reported | — | 6 | 6 | 7 | $1.50 |
| #14 | D13 ✓ | 1 true, 1 false | 20 | 20 | 30 | $7.48 |

**0.5.0-codex**: codex agents on gpt-5.6-sol (codex-cli 0.153.4, 3 at once)

| PR | Planted | Other confirmed findings | Agents | Calls | Minutes | Cost |
| :- | :- | :- | -: | -: | -: | :- |
| #4 | D4 ✓ | 1 true, 3 pre-existing | 18 | 18 | 11 | 4.5M in (89% cached), 72k out |
| #7 | D7 ✓, D8 ✓ | 5 true, 1 pre-existing | 18 | 18 | 15 | 4.6M in (90% cached), 108k out |
| #11 | clean; 1 reported | 1 pre-existing | 6 | 6 | 5 | 1.6M in (90% cached), 24k out |
| #14 | D13 ✓ | 5 true, 1 false, 1 pre-existing | 19 | 19 | 15 | 5.3M in (90% cached), 123k out |

Every agent of every run answered in shape: no retries, no failed or timed-out calls, no
run incomplete. Codex's extra findings are the rollout-window and timer hazards on #14,
the cutover double credit of migration 004, and the name-check and sign-in-warning gaps
on #7; its one false finding, that a failed hourly save leaves the credit only in memory,
describes how every write in the service works. Claude's one false finding, that the
hourly loop blocks the event loop, describes the same thing. The finding Claude found and
then refuted on #14, the previous release's writes stripping `lastAccruedOn`, is the one
the 0.4.0 pass confirmed (true, narrow). The one pre-existing finding on the clean PR,
CSV cells with a bare carriage return, is true about main and is now K5.

## What the numbers mean

Recall is over planted defects: the review was told nothing about them, and the PRs
read like ordinary PRs. Precision is over confirmed findings, after the skeptics; a
review that finds everything by reporting everything scores badly on it. Both are
measured on one small, dependency-free service, with the generic angles only; a
project with angles of its own should do better on its own bugs, and a large codebase
will be harder than this one. Treat the numbers as a floor for the method, not a
promise for your repository.

The caveat that matters: the fixture's name says what it is. An agent that reads the
README learns the repository exists to be reviewed, which may make it look harder than
it would at a PR of yours. The answer key is not reachable from any branch.

## Results

### 0.4.0 — 14 October 2026, Sonnet agents

Both sets, after the same-site check and branch review: one review per PR from a fresh
clone with `run.sh` in two lanes, Sonnet agents, Opus orchestrating, the computed
ceiling of 20. Results in `results/0.4.0/`.

| | v1, #1 to #11 | v2, #12 to #21 |
| :- | :- | :- |
| Planted defects confirmed | **9 of 10** | **8 of 8** |
| Confirmed findings true | 15 of 15 | 18 of 18 |
| On the clean PRs | no findings | no findings |
| Agents per PR | 4 to 20, mean 12.0 | 3 to 19, mean 12.7 |
| Time per PR | 10 to 23 minutes | 13 to 35 minutes |

259 agents and about 117 dollars at list price for the 21 reviews.

| PR | set | planted | angles run | dropped | agents | minutes | raw | root causes | upheld | refuted |
| :- | :- | :- | -: | -: | -: | -: | -: | -: | -: | -: |
| #1 | v1 | D1 | 3 | 5 | 9 | 10 | 4 | 1 | 1 | 0 |
| #2 | v1 | D2 | 5 | 4 | 14 | 19 | 7 | 2 | 2 | 0 |
| #3 | v1 | D3 | 4 | 4 | 8 | 14 | 2 | 1 | 1 | 0 |
| #4 | v1 | D4 | 6 | 2 | 12 | 21 | 6 | 1 | 1 | 0 |
| #5 | v1 | D5 | 6 | 3 | 12 | 14 | 6 | 1 | 1 | 0 |
| #6 | v1 | D6 | 5 | 4 | 14 | 23 | 5 | 2 | 2 | 0 |
| #7 | v1 | D7, D8 | 7 | 2 | 20 | 17 | 8 | 3 | 3 | 0 |
| #8 | v1 | D9 | 6 | 2 | 16 | 23 | 9 | 3 | 3 | 0 |
| #9 | v1 | D10 | 6 | 2 | 17 | 22 | 5 | 3 | 2 | 1 |
| #10 | v1 | clean | 4 | 4 | 6 | 19 | 0 | 0 | 0 | 0 |
| #11 | v1 | clean | 2 | 6 | 4 | 15 | 0 | 0 | 0 | 0 |
| #12 | v2 | D11 | 4 | 4 | 13 | 17 | 4 | 2 | 2 | 0 |
| #13 | v2 | D12 | 5 | 4 | 15 | 35 | 11 | 4 | 3 | 1 |
| #14 | v2 | D13 | 6 | 3 | 18 | 31 | 8 | 3 | 3 | 0 |
| #15 | v2 | D14 | 6 | 2 | 16 | 33 | 8 | 2 | 2 | 0 |
| #16 | v2 | D15 | 5 | 3 | 12 | 19 | 4 | 3 | 3 | 0 |
| #17 | v2 | D16 | 5 | 3 | 14 | 32 | 9 | 2 | 2 | 0 |
| #18 | v2 | D17 | 4 | 4 | 10 | 16 | 5 | 1 | 1 | 0 |
| #19 | v2 | D18 | 7 | 2 | 19 | 23 | 7 | 3 | 3 | 0 |
| #20 | v2 | clean | 5 | 4 | 7 | 13 | 0 | 0 | 0 | 0 |
| #21 | v2 | clean | 1 | 7 | 3 | 15 | 0 | 0 | 0 | 0 |

**The miss.** D3 on #3: the seed script still calls the old `openAccount` signature.
No finder opened `scripts/seed.mjs` this time. The critic named it, with the crash
reproduced, but the critic's gaps are reported unverified and do not count. 0.2.0 and
0.3.0 both confirmed it, and nothing a finder sees on a pull request changed in 0.4.0, so
this is run-to-run variance in the finders, seen once.

**The harder set was not harder.** Every v2 defect was confirmed. The likely reasons:
`docs/security.md` and `docs/deploy.md` state the rules most v2 defects break, which
gives a reviewer who reads the docs a checklist, and the service is still small enough
to read whole. The set gives no headroom yet; a larger codebase, or defects against
conventions nobody wrote down, would.

**Findings nobody planted.** Fourteen confirmed findings, five on v1 and nine on v2, are
true defects that nobody planted. On v2: the fraud screen is never wired in production;
the new list cache grows without bound; during a rollout an idle copy's hourly save
overwrites the other copy, and old copies strip `lastAccruedOn` and `frozenAt`, the
second unfreezing accounts; an idempotency record is written before its commit; frozen
state is invisible in the API; and the new webhook route sends duplicates and answers a
null body with a 500. On v1, two repeat from earlier passes, the control-character
regex and #9's seed script, and three are new: a null-body 500 on #3, the running total
drifting during a rollout on #8, and an administrator able to act as another
administrator on #6. Each is in `manifest.json` under `adjudicated`, with its reasoning.
Two findings were pre-existing and left out: a temp-file race in `save()`, now recorded
under `known`, and the whole-file save the fixture's README already lists as a
limitation.

**The same-site check** ran on #7, #9 and #15 and merged nothing: each time the groups
at one place were distinct defects, which it ruled correctly. The duplicate it was built
for did not recur, because triage grouped #7's findings itself. The check's merge path
is tested but was not exercised by a real run.

**Branch review.** `--branch origin/feat/overdraft`, with no pull request, reviewed the
same head as #4 and confirmed D4. `--branch origin/feat/freeze-account` reviewed the same
head as #19 and confirmed D18; it also reported four findings the PR run did not: a
deposit into a frozen account, interest on a frozen account, unfreezing without telling
the card processor, and freeze and close ignoring each other. Branch results are not
scored.

### 0.3.0 — 14 October 2026, Sonnet agents

The same eleven PRs, same setup, after the blind-test rule (a test that cannot fail is
evidence on the defect it hides, not a finding of its own, and nothing when the code
under it is right). Run with `run.sh`, Sonnet agents, the orchestrating session on the
machine's default model. Results in `results/0.3.0/`.

| | 0.3.0 | 0.2.0 |
| :- | :- | :- |
| Planted defects confirmed | **10 of 10**, none wrongly refuted, none missed | 10 of 10 |
| Confirmed findings true | **15 of 15**: 12 on planted defects, 3 adjudicated true | 20 of 25 |
| On the two clean PRs | **no findings** | 3, all false |
| Agents | 130 over 11 PRs; 3 to 18 per PR, mean 11.8 | 152; 7 to 20, mean 13.8 |
| Time per PR | 15 to 28 minutes, mean 21 | 13 to 28, mean 21 |
| Cost | about 55 dollars at list price, by the sessions' own cumulative figures | about 63 by the same method |

| PR | planted | angles run | dropped | agents | minutes | raw | root causes | upheld | refuted |
| :- | :- | -: | -: | -: | -: | -: | -: | -: | -: |
| #1 | D1 | 4 | 5 | 10 | 22 | 6 | 1 | 1 | 0 |
| #2 | D2 | 8 | 3 | 17 | 20 | 9 | 2 | 1 | 1 |
| #3 | D3 | 4 | 4 | 10 | 17 | 2 | 1 | 1 | 0 |
| #4 | D4 | 7 | 2 | 13 | 28 | 8 | 1 | 1 | 0 |
| #5 | D5 | 7 | 2 | 13 | 16 | 8 | 1 | 1 | 0 |
| #6 | D6 | 4 | 5 | 10 | 23 | 5 | 1 | 1 | 0 |
| #7 | D7, D8 | 5 | 3 | 18 | 26 | 10 | 5 | 5 | 0 |
| #8 | D9 | 7 | 2 | 13 | 21 | 10 | 1 | 1 | 0 |
| #9 | D10 | 7 | 3 | 17 | 24 | 5 | 3 | 3 | 0 |
| #10 | clean | 4 | 4 | 6 | 20 | 0 | 0 | 0 | 0 |
| #11 | clean | 1 | 7 | 3 | 15 | 0 | 0 | 0 | 0 |

Every planted defect came back as one finding, with the PR's blind test among its
sites where there was one, and no finding was rated above the defect it names. The
three true findings nobody planted are the null-body 500s on the export and account
routes, now rated low and medium, and the seed script broken by #9's rename. One
blemish on #7: the traversal came back twice, once under security and once re-described
under data-integrity, a duplicate triage did not merge; and a distinct true finding
beside it, a global export namespace where two owners choosing the same name overwrite
each other's file. The caveats below still apply, and each PR was again reviewed once.

### 0.2.0 — 14 October 2026, Sonnet agents

One review per PR from a fresh clone, no `--agents` (the computed ceiling, 20), Sonnet
as the agents' model and Opus orchestrating. The result files are in `results/0.2.0/`;
`node calibration/score.mjs` reproduces every number below from them and the manifest.

| | |
| :- | :- |
| Planted defects confirmed | **10 of 10**; none wrongly refuted, none missed |
| By angle | every generic angle caught the defect planted for it; authz-and-attribution and security caught two each |
| Confirmed findings true | **20 of 25**: 11 on planted defects, 9 adjudicated true, 5 adjudicated false |
| On the two clean PRs | 3 confirmed findings, all false |
| Agents | 152 over 11 PRs; 7 to 20 per PR, mean 13.8 of the ceiling of 20; no retries, no agent lost, nothing left unverified |
| Time to result | 13 to 28 minutes per PR, mean 21 |
| Cost | about 63 dollars at list price, by the sessions' own cumulative figures |

| PR | planted | angles run | dropped | agents | minutes | raw | root causes | upheld | refuted |
| :- | :- | -: | -: | -: | -: | -: | -: | -: | -: |
| #1 | D1 | 3 | 5 | 12 | 28 | 5 | 2 | 2 | 0 |
| #2 | D2 | 8 | 2 | 20 | 17 | 17 | 3 | 3 | 0 |
| #3 | D3 | 5 | 4 | 12 | 16 | 4 | 2 | 2 | 0 |
| #4 | D4 | 6 | 2 | 18 | 22 | 12 | 3 | 3 | 0 |
| #5 | D5 | 7 | 3 | 16 | 22 | 12 | 2 | 2 | 0 |
| #6 | D6 | 2 | 6 | 9 | 13 | 3 | 2 | 2 | 0 |
| #7 | D7, D8 | 8 | 2 | 18 | 16 | 14 | 3 | 3 | 0 |
| #8 | D9 | 7 | 2 | 17 | 23 | 13 | 3 | 3 | 0 |
| #9 | D10 | 5 | 3 | 14 | 25 | 4 | 2 | 2 | 0 |
| #10 | clean | 5 | 3 | 9 | 24 | 2 | 2 | 2 | 0 |
| #11 | clean | 3 | 5 | 7 | 23 | 2 | 2 | 1 | 1 |

*Angles run* counts the generic angles the scout kept plus the ones it added for the
PR; *dropped* is what it ruled out with a reason. *Raw* is findings before triage.

**The five false positives.** Every one is a coverage note on code the review itself
found correct, or a design remark; none claims a failure the code does not have:
on #3 that no test has the owner differ from the actor; on #8 that the closed-account
refusal in `withdraw` is untested; on #10 that the audit test uses one transfer, and
that the audit route scans the whole collection as every sibling route does; on #11
that the currency test uses one currency for both accounts, which a transfer requires.
The reasoning for each is in `manifest.json` under `adjudicated`.

**The nine true, unplanted findings.** Seven are the PR's own test being blind to the
planted defect, reported beside it as its own root cause: true, useful, and only
countable once a person rules. One is a real defect introduced by accident, the
renamed parameter in #9 breaking the seed script, the same class planted in #3. One
is a 500 on a literal `null` body at the new destructuring in #7. One is #2's
control-character regex missing C1 and the Unicode line separators.

**Severity.** The review rates a test gap as high or critical when the defect it hides
is; on its own a test gap is lower. Read a finding's severity as the severity of what
it points at.

**Caveats.** Sonnet agents, where users get Opus by default, so treat this as a floor.
One small, dependency-free service, generic angles only, each PR reviewed once, so no
variance measured. The fixture's name says what it is. The adjudications are the
author's, recorded with their reasons for anyone to dispute.

## Adding a defect

In the fixture: branch from `main`, add a feature in the ordinary way, let the defect
ride in with it, write tests that pass, open the PR with an innocent description. Here:
add the entry to `manifest.json` with the file and lines at the branch head, and show
the defect bites before you commit the entry.
