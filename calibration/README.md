# Calibration

How well does the review find what is there, and how much does it report that is not?
This directory measures that against a fixture with known defects.

- **The fixture**: [adv-review-calibration](https://github.com/YahampathChandika/adv-review-calibration),
  a small ledger service (accounts, transfers, a JSON store with migrations, bearer
  tokens, an audit log, CSV export; no dependencies). Its `main` is meant to be clean.
  Each pull request adds a feature in the ordinary way; most carry one planted defect
  that the PR's own tests do not catch, two carry none.
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

Every defect was shown to bite on its branch before the key was written: the script
that does so is not part of the fixture, so the agents cannot read it.

## Run a pass

`run.sh` runs one headless review per PR from a clone of the fixture and writes each
result where the scorer reads it. Clone the fixture, sign `gh` in to github.com, then:

```
calibration/run.sh ../adv-review-calibration calibration/results/<version> 1 2 3 4 5 6 7 8 9 10 11
```

`MODEL` picks the agents' model (default `sonnet`, which the published numbers use;
`MODEL=opus` for the default users get). For two lanes, run it twice with disjoint PR
lists in two separate clones; one clone cannot host two sessions at once. A review
takes 15 to 30 minutes on the fixture. The session runs in permission mode `auto`,
which approves what the review needs and refuses the rest.

Results are kept per version under `results/`, so passes are comparable. Then:

```
node calibration/score.mjs                # the newest results/<version>/
node calibration/score.mjs --results calibration/results/0.2.0
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
its grouped sites. Unknown is not true, so an unadjudicated finding lowers precision.

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
| Cost | about 65 dollars at list price for the pass, by the sessions' own estimates |

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
