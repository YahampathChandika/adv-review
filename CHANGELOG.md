# Changelog

## Unreleased

- `/adv-review:review 140 --agent claude,codex`: two or more agents, comma separated,
  review the pull request once each through the runner and the session reports the
  comparison. Never posts. A model may follow each agent after a colon,
  `--agent claude:sonnet,codex:gpt-5.5`; the runner's `--agent` takes the same form.
- `/adv-review:review --compare claude.json codex.json`: no review; results written
  earlier with `--out` put side by side.

## 0.5.3 — 2026-10-15

- `/adv-review:review 140 --agent codex` (or `gemini`, `copilot`) in Claude Code runs the
  review with that CLI's agents through the runner and reports as usual. The skill finds
  the runner through `$CLAUDE_PLUGIN_ROOT` in an installed plugin.

## 0.5.2 — 2026-10-15

- `--agent copilot`: the GitHub Copilot CLI as a fourth agent, through `copilot -p` in
  silent mode with the answer asked for in the prompt and checked by the runner. Its tool
  allow-list enforces `--no-run` (git shell commands only, writes denied); the repository's
  own Copilot extensions stay out of each agent. Experimental, built against a stand-in
  CLI and not benchmarked: no Copilot plan.

## 0.5.1 — 2026-10-15

- `runner/compare.mjs` puts reviews of one commit by different agents side by side:
  what every agent found, what only some did, what one confirmed and another refuted,
  and the agents, minutes and cost of each run.

## 0.5.0 — 2026-10-15

Benchmarked through the runner on a four-PR sample of the fixture (#4, #7, #14, #11),
next to the 0.4.0 plugin pass on the same PRs. Claude agents on Sonnet: 4 of 4 planted
defects confirmed, 6 of 7 confirmed findings true, nothing on the clean PR, $16. Codex on
its default model, `gpt-5.6-sol`: 4 of 4, 21 of 22, one pre-existing finding on the clean
PR, 15.9M input tokens. Gemini not run: no plan. See `calibration/README.md`.

- A standalone runner, `runner/review.mjs`, runs the same review with each agent as a
  headless CLI process in its own git worktree: `--agent claude`, `codex` or `gemini`,
  with `--model` choosing the model within the vendor. It prepares the pull request or
  branch, enforces each agent's answer shape (Claude and Codex through their CLIs,
  Gemini through the runner's own check and one retry), caps concurrency with `--jobs`,
  writes `--out`, posts with `--post`, and records what produced the result under
  `runner`. Codex and Gemini are experimental; Gemini has not been run against a real
  CLI. The runner is also the way to run the review from CI or with an API key.
- The skill works for agents without a Workflow tool: it tells them to run the runner.
- A capability matrix in the README says what each agent enforces.
- Agents' worktrees may start at the commit under review, not only on main; the
  prompt says so. Codex's sandbox keeps `.git` read-only, so the agent's own checkout
  cannot be relied on there.
- `calibration/bench.sh` runs a four-PR sample through the runner for one agent, and
  `calibration/bench-table.mjs` renders result folders as the table the README carries.
- Scorer: a ruling whose lines contain a finding's line outranks one merely within the
  window, and a ruling may carry `finding`, a regular expression on the title, so two
  findings on one line can be ruled apart.

## 0.4.0 — 2026-10-15

Calibrated on both sets with Sonnet agents: 17 of 18 planted defects confirmed, none
wrongly refuted; 33 of 33 confirmed findings true; no findings on the four clean PRs.
The one miss, D3, was named by the critic but not verified. See `calibration/README.md`.

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
- The scorer marks a missed defect that the critic named among its gaps: seen, never
  verified, still a miss.
- `calibration/run.sh` takes `branch:<ref>` targets, and now stops each session it
  starts. It used to stop the shell around the session instead, so every review session
  of a pass kept running after it finished.

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
