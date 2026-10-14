# Changelog

## Unreleased — 0.4.0

- `--branch [name]` reviews a branch with no pull request, against `--base` or the
  remote's default branch. Committed work only; report only, nothing to post.
- A same-site check after triage: when separate groups sit at the same place in the
  code, one agent rules whether they are one defect or several. Only groups that share
  a place can merge; a failed check, or no room under the ceiling, leaves them as
  triage made them. The 0.3.0 calibration reported one path traversal twice.
- Fixed: a retried triage could take a run one agent past its ceiling. The skeptics
  are now counted from what is spent after triage, not before it.
- A second, harder calibration set: the fixture gains interest, webhooks and a read
  cache, and PRs #12 to #21 carry eight defects that need more than the changed lines
  to see, plus two clean PRs. The answer key labels each entry with its set; the scorer
  reports each set and takes `--set`.
- `calibration/verify/verify.mjs` shows every planted defect biting on its branch, from
  a clone of the fixture.

## 0.3.0 — 2026-10-14

Calibrated again on the same eleven PRs with Sonnet agents: all ten planted defects
confirmed, none wrongly refuted; 15 of 15 confirmed findings true; no findings on the
two clean PRs; 130 agents against 152. See `calibration/README.md`.

- A test that cannot fail is no longer a finding of its own. When it hides a defect in
  the diff, the defect is the finding and the blind test is one of its sites, named in
  the summary; when the code under it is right, nothing is reported. Finders, triage and
  the skeptics are each told so, and a blind test can no longer lead a root cause or set
  its severity. In the 0.2.0 calibration this class was every false positive and seven
  of the nine true findings nobody planted.
- `--model <name>` picks the subagents' model for one run.
- `calibration/run.sh` runs the calibration pass headless, one review per PR from a
  clone of the fixture, and results are kept per version under `calibration/results/`.

## 0.2.0 — 2026-10-14

Calibrated: on the fixture, with Sonnet agents, all ten planted defects confirmed and
none wrongly refuted; 20 of 25 confirmed findings true after adjudication; three
findings on the two clean PRs, all false. See `calibration/README.md`.

- Every finding says whether the PR introduced the defect or it was already on the base
  commit (`introducedByDiff` from the finders, correctable by a skeptic; `preexisting` in
  the result). Pre-existing findings are reported apart and left out of the posted
  comment unless `--include-preexisting` is passed.
- A refuted finding that nobody showed false, where every skeptic was unsure, is marked
  `dismissedAsUnsure` and listed for a person to glance at.
- An agent that dies, or that answers about the wrong commit, is retried once while the
  ceiling has room. A retry is an agent spent; the result lists `retried`.
- Given no `--agents`, the run computes the smallest ceiling with room for every fixed
  angle and two of the scout's own, never under 20.
- `--out <path>` writes the run's result JSON to a file.
- A calibration set: a public fixture repository with ten planted defects across the
  eight generic angles and two clean PRs, the answer key in `calibration/manifest.json`,
  and `calibration/score.mjs`, which scores `--out` results for recall and precision.
- An eval case (`evals/review-smoke`) for `claude plugin eval` that runs one real review
  from a fresh clone of the fixture.

## 0.1.0 — 2026-10-13

First public release.

- The review workflow: scout, one finder per angle, triage by root cause, skeptics told
  to refute, a completeness critic. Every failure path is tested without spending an
  agent.
- Eight generic angles, and a per-project config file (`.claude/adv-review.json`) for
  the project's own angles, install and check commands, default ceiling and model.
- Every agent works in its own git worktree at the PR's head commit; an answer about
  any other commit is discarded.
- The agent count is a ceiling. When it cuts an angle the scout kept, the run names the
  ceiling that would have run it and reports itself incomplete.
