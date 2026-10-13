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

From a clone of the fixture, with the plugin installed, one review per PR:

```
/adv-review:review <n> --no-post --out <this repo>/calibration/results/pr-<n>.json
```

Then, from this repository:

```
node calibration/score.mjs                # reads calibration/results/pr-*.json
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

## Adding a defect

In the fixture: branch from `main`, add a feature in the ordinary way, let the defect
ride in with it, write tests that pass, open the PR with an innocent description. Here:
add the entry to `manifest.json` with the file and lines at the branch head, and show
the defect bites before you commit the entry.
