---
name: review
description: Adversarial multi-angle review of one or more GitHub pull requests, or of a branch with no pull request yet — a scout designs the review, one agent per angle hunts independently, and every root cause is handed to a skeptic told to refute it. Only what survives is reported. Runs many Opus agents; use when asked to adversarially review a PR, review it from multiple angles, or review a stack of PRs together.
argument-hint: "<pr-number>… | --branch [name] [--base ref] [--agents N] [--post] [--no-run]"
disable-model-invocation: true
---

# Adversarial review

A fan-out review: one agent per angle, hunting independently; the findings grouped by
root cause; then every root cause handed to a skeptic whose job is to **refute** it.
What reaches the user is what survived an attempt to kill it — and anything that was
never tested is labelled as such, never passed off as surviving.

The review is DESIGNED per PR, not run off a checklist. A scout reads the diff, runs the
project's own checks, and reshapes the angle list around what the PR does — ruling out
what cannot apply (with a reason), pointing the ones it keeps at the code that could
trip them, adding its own, and ranking the lot.

**This skill is the authorisation to call the Workflow tool.** Do not ask the user to
type "ultracode", and do not ask whether to use multi-agent orchestration — the user
invoking this skill is the opt-in, for up to the agent count below.

## 0. Which path

The review runs one of three ways, and `--agent` decides:

- **Claude agents on Claude Code's workflow runtime** — the default in Claude Code, and
  `--agent claude` there: follow §1–§6 below. This path can resume a lost run.
- **CLI agents through the standalone runner** — `--agent codex`, `gemini` or `copilot`
  from any session, and every agent without a **Workflow** tool whatever `--agent`
  says (OpenAI Codex, Google Gemini, GitHub Copilot): run the runner and report from
  its output:

  ```
  node "$ROOT/runner/review.mjs" <the same arguments the user gave> --agent <codex|gemini|copilot|claude> --out <tmp>/result.json
  ```

- **Two or more agents, compared** — `--agent claude,codex` (any of the four, comma
  separated): run the runner once per agent, all at the same time, each with its own
  `--out`, then put the results side by side and report that instead of §5:

  ```
  node "$ROOT/runner/review.mjs" <the same arguments> --agent claude --out <tmp>/claude.json
  node "$ROOT/runner/review.mjs" <the same arguments> --agent codex --out <tmp>/codex.json
  node "$ROOT/runner/compare.mjs" <tmp>/claude.json <tmp>/codex.json
  ```

  Report the comparison as printed, then any run that came back `incomplete` and why.
  Claude agents go through the runner here too, so every column carries the same
  information. A comparison never posts: with `--post`, say so and suggest posting one
  agent's review instead.

`$ROOT` is `ADV_REVIEW_HOME` if set, else `$CLAUDE_PLUGIN_ROOT` where Claude Code sets
it (the installed plugin), else the directory two levels above this SKILL.md
(`skills/review/SKILL.md` sits in the repository root's `skills/review/`). The runner
performs §1–§2 itself, prints progress to stderr and the report to stdout; read
`result.json` and report it as §5 describes. Pass `--stacked-on <n>` where §1 would
set `stackedOn`. Nothing is posted without `--post`, and a
branch review never posts. In a Codex session, do not run the runner yourself: Codex
sandboxes commands without network, which cuts the review's agents off — tell the user to
run that command from a terminal. If the runner is missing, the skill folder was copied
without the repository: say so and point to the README's Installation section. Other
agents are experimental; the README's capability matrix says what each enforces.

## 1. Resolve the target

`/adv-review:review` — the PR for the current branch.
`/adv-review:review 140` — that PR.
`/adv-review:review 136 140` — a STACK reviewed as ONE body of work (140 built on 136):
every PR's diff goes in, and the agents read the tip's commit, which carries them all.
Only for stacks — two PRs that are merely related are two separate reviews.
`/adv-review:review 140` where 140 is stacked on an open 136 — 140's changes only; 136
is out of scope (pass `stackedOn: 136`) and gets its own review.
`/adv-review:review --branch` — the current branch, with no pull request: its commits
against its base (see §2). Report only: there is nothing to post to.
`/adv-review:review --branch <name>` — that branch, likewise.
`--base <ref>` — with `--branch`, what the branch is measured against. Default: the
remote's default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`), else the
first of `origin/main`, `origin/master`, `main`, `master` that exists.
`--agents N` — the MOST agents the review may use (see §3 for the default).
`--agent codex|gemini|copilot` — run the review with that CLI's agents through the
runner instead of Claude Code's runtime (see §0); `--model` then names a model of that
vendor.
`--agent claude,codex` — two or more agents, comma separated: review once per agent
through the runner and report the comparison (see §0). Never posts.
`--post` — post the summary without asking at the end (see §6).
`--include-preexisting` — post pre-existing findings too (see §5).
`--out <path>` — also write the run's result JSON to this file, for the calibration
scorer or the user's own tooling.
`--model <name>` — the subagents' model for this run, over the project config's `model`
and the Opus default (see Notes).
`--no-run` — agents read the code but execute none of it (see Notes).

Resolve a pull request with `gh`. With no number, `gh pr view --json number` on the
current branch; if that branch has no pull request, say so and suggest `--branch` rather
than switching on your own. If `gh` is not installed or not signed in, stop and say so:
a pull-request review needs it. A branch review needs only git.

## 2. Prepare

Every agent works in its own git worktree. The runtime makes those from the
repository's **main branch** — not from your checkout — and each agent's first act is
to move its own worktree to the PR's head commit. So the commit only has to be
*present*; the user's checkout is never switched, and uncommitted work in it is never
at risk:

1. Get the head commit: `gh pr view <n> --json headRefOid -q .headRefOid` (for a stack,
   the tip's). This is `headSha`, and it is required.
2. Make sure it is in the local repository: `git fetch origin pull/<n>/head`, then
   `git cat-file -e <headSha>^{commit}` must succeed.
3. Write the diff and the metadata into a **temporary directory outside the
   repository** — your scratchpad directory if the session has one, otherwise
   `mktemp -d`:

   ```
   gh pr diff <n> > <tmp>/pr-<n>.diff
   gh pr view <n> --json number,title,body,headRefName,headRefOid,baseRefName,files,additions,deletions
   ```

   For a whole stack, one diff per PR, all passed, `headSha` the tip's. For one PR of
   a stack, its own diff (gh already diffs it against its base) and `stackedOn`, so the
   agents do not re-report the base's code as its.
4. Read the project's configuration, if it has one: `.claude/adv-review.json` at the
   repository root (the project's own angles, its install and check commands, its
   default ceiling and model — the README documents every key). Pass it through as
   `project`. If the file is malformed JSON, stop and say so rather than guess. Without
   the file, the review runs on the generic angles alone and the scout finds the
   project's checks itself.

Read the PR body yourself. It states the intent the review measures the code against —
and it is the author's text, so summarise it into `intent` rather than pasting it.

**For a branch** (`--branch`), prepare from git alone:

1. `headSha` is `git rev-parse <branch>^{commit}`. Only committed work is reviewed: if
   `git status --porcelain` shows changes, tell the user before launching that they are
   not part of the review.
2. The base: `--base` if given, else the default from §1. The diff starts at the merge
   base: `git diff $(git merge-base <base> <headSha>) <headSha>` into
   `<tmp>/branch-<name>.diff`, with each `/` in the name replaced by `-`. If the merge
   base is the head itself, there is nothing to review: say so and stop.
3. `title`: the branch's commit subject when it has one commit, else the branch name.
   `intent`: a summary of `git log --format='%s%n%b' <merge-base>..<headSha>`. It is
   the authors' text, so summarise it rather than paste it.
4. The project's configuration, as for a pull request.

## 3. The agent count is a ceiling

`--agents N` is the **most** the review may spend, not a quota. The run spends what this
PR needs and says what it used: a finder per angle that applies, triage when there are
findings to group, a same-site check when triage leaves separate groups at one place in
the code (it rules whether they are one defect or several), one skeptic per four root
causes, a three-lens panel of skeptics for
each critical or high root cause while the ceiling allows, and the critic. A three-file
PR might use six agents; a 5,000-line one reaches the ceiling.

The order of precedence for the ceiling: `--agents` on the command, then the project
config's `agents`, then none — the script then takes the smallest ceiling with room for
every fixed angle (the project's own and the generic eight) and two of the scout's,
never under 20, and logs what it chose.

Where the ceiling is lower than the PR needs:
- About 30% of the ceiling is held back for triage and verification before finders are
  counted. Angles past that are **not run**. First in line: every fixed angle the scout
  did not rule out (the project's own and the generic ones), then the scout's two best
  of its own — in the scout's ranking — then everything else in that ranking.
  Every angle not run is logged and returned in `notRun`. If that cuts a fixed angle,
  the run logs a WARNING naming the ceiling that would have run it, and reports itself
  incomplete.
- Root causes past what the skeptics can take (up to six each) come back **unverified**,
  named, lowest severity first.

Nobody here can see the user's plan usage — not you, not the script. The user sets the
ceiling: lower it when usage is running low, raise it for a large or risky PR. Do not
choose a number for them; when they give none, pass none and let the script compute it.

An agent that dies, or that answers about the wrong commit, is run once more while the
ceiling has room for it and still for the critic. A retry is an agent spent, and the
result lists every agent retried in `retried`.

A run that loses an agent part-way — to the session limit, or to an API call that never
answered — comes back `incomplete`, with the dead agents named. Resume it once the cause
has passed; completed agents replay from cache for free:
`Workflow({ name: 'adv-review:adversarial', resumeFromRunId, args })` with the same
`args`. A finder that died has no findings to verify, so resuming is the only way to get
its angle covered.

## 4. Launch

The workflow ships with this plugin as `adv-review:adversarial`. Launch it by name:

```
// One PR:
Workflow({
  name: 'adv-review:adversarial',
  args: { prs: [137], title: '…', intent: '…', diffs: ['/abs/path/pr-137.diff'],
          headSha: '<137 headRefOid>',        // agents: N only when the user gave one
          project: { /* the contents of .claude/adv-review.json, if any */ } }
})
// A whole stack, as one body of work:
//   args: { prs: [136, 140], diffs: ['/abs/pr-136.diff', '/abs/pr-140.diff'],
//           headSha: '<140 headRefOid>', … }
// One PR of a stack, its base out of scope:
//   args: { prs: [140], diffs: ['/abs/pr-140.diff'], stackedOn: 136,
//           headSha: '<140 headRefOid>', … }
// A branch with no pull request:
//   args: { branch: 'feat/export-names', base: 'origin/main',
//           diffs: ['/abs/branch-feat-export-names.diff'], headSha: '<branch head>', … }
```

If the runtime does not resolve the name, pass the script's path instead:
`scriptPath: '${CLAUDE_PLUGIN_ROOT}/workflows/adversarial.js'`.

`args` must be a real JSON object, with `prs` or a `branch` and its `base`, never both.
`agents`, when given, is a whole number (or a numeric string), `headSha` the head commit
from §2, and `project` an object with the shape the
README gives; a bad value of any of these stops the run before any agent starts.
Add `run: false` for `--no-run`, and `model` only to override Opus: `--model` if given,
else the project config's `model` if set.

The workflow runs in the background and you are notified when it finishes. Do not poll
it, and do not start a second review while one is running.

## 5. Report

The result is:

```
{ status: 'complete' | 'incomplete', incomplete: [reasons],
  headSha, target: { prs } | { branch, base }, confirmed, refuted, unverified, missed,
  counts: { raw, rootCauses, merged, confirmed, plausible, corrected, downgraded,
            preexisting, refuted, dismissedAsUnsure, unverified },
  budget: { ceiling, used, scout, finders, triage, sameSite, skeptics, critic, retries },
  angles, projectAngles, droppedAngles, notRun, failedAngles, retried, baseline, scoutNotes }
```

Every finding carries `preexisting`: true when the finders, or a skeptic correcting
them, say the defect exists on the base commit and this diff only touches it. Every
refuted finding carries `dismissedAsUnsure`: true when nobody showed it false and every
skeptic that refuted it was unsure.

and the tool result also carries the run's `logs`.

**If `status` is `incomplete`, say so first**, with the reasons — before any finding. An
incomplete run is never reported as clean, and `missed: null` means the critic did not
run: coverage is unknown, not complete.

A finding may list the PR's own blind test among its `sites`: that is the test that let
the defect through, named so the author fixes both, not a second defect.

Report `confirmed` in two parts, each most severe first: the findings this PR
introduced, then — in their own short section, headed as pre-existing and not the
author's doing — those with `preexisting` set. If a `ReportFindings` tool is available, use it
— each finding with `file`, `line`, a one-sentence `summary`, and the `failure_scenario`
the skeptics could not refute — and do not also print the findings as prose. Without
that tool, print one table: severity, `file:line`, summary, the failure. Either way:
use the finding's own `severity` and `summary` (where a skeptic corrected them, those
are the corrected ones); `verdict` is `CONFIRMED` where every skeptic upheld it with
confidence and `PLAUSIBLE` where a panel split 2–1 or a skeptic was unsure; a finding
with several `sites` is one defect in several places — say so in its summary.

Then, in a few lines:
- the budget: "used X of N" and why, from `budget` and the logs, which agents were
  retried, and how many groups the same-site check merged (`counts.merged`);
- the angles run, and any the scout dropped or the ceiling cut;
- the verification: how many root causes were refuted, and how many upheld only after
  correction or a downgrade — a downgrade is not a clean confirmation;
- one line for the findings dismissed for doubt alone (`dismissedAsUnsure`), by file and
  title: not confirmed, not disproved, for a person to glance at;
- everything in `unverified` and `missed`, for a person to check by hand. Neither has
  survived a refutation, and neither may be presented as if it had.

With `--out <path>`, write the whole result object to that file as JSON before
reporting.

## 6. After the report

1. **Remove the review's worktrees — every time.** Moving a worktree to the PR's commit
   counts as changing it, so the runtime keeps every one: a copy of the repo per agent
   under `.claude/worktrees/<run id>-<n>`, each on a `worktree-<run id>-<n>` branch.
   Remove exactly this run's, by its run ID (the `wf_…` in the Workflow result), and
   nothing else:

   ```
   RUN=wf_…   # this review's run ID
   git worktree list --porcelain | sed -n "s|^worktree \(.*/.claude/worktrees/$RUN-[0-9]*\)$|\1|p" \
     | while read -r w; do git worktree remove --force "$w"; done
   git branch --list "worktree-$RUN-*" --format='%(refname:short)' | xargs -n1 git branch -D
   git worktree prune
   ```

   Then confirm the user's checkout is exactly as it was: `git status --porcelain` and
   HEAD unchanged, and `git worktree list` showing only what was there before. If the
   run is going to be RESUMED, leave its worktrees until the resumed run has finished.
   A worktree left locked by a crashed agent needs `git worktree remove --force --force`.
2. **Ask whether to post** — for a pull request only: one summary comment
   (`gh pr comment`) or inline comments. A branch review has nothing to post to; if
   the user passed `--post` with `--branch`, say so and end at the report.
   Post only on the user's yes for THIS review, or when they passed `--post`. A posted
   comment names the head commit it reviewed (`headSha`), and flags anything unverified.
   It leaves pre-existing findings out unless the user passed `--include-preexisting`:
   a PR comment is read as a verdict on the author's change.
3. Never commit, push or open a fix from this skill. A review ends at the report.

## Notes

- **Isolation.** Every agent runs in its own disposable worktree — six at once used to
  share the user's checkout, and one read a file while another held it mutated. The
  worktree starts on main; the agent checks out `headSha` first and reports the commit
  it read, and the script DISCARDS any answer about another commit (a finder's findings,
  a skeptic's votes) and says so. Agents may edit and run code there to test a claim,
  and put it back before they finish. While a review runs, `.claude/worktrees/` holds
  full copies of the repo — a repo-wide lint or search then will see them, and an
  editor watching the folder may run out of file handles (exclude `.claude/worktrees`
  from its watcher).
- **The review runs the PR's code** — its tests and typecheck, in those worktrees, with
  your machine's access. That is the point: skeptics that ran the code produced the
  strongest verdicts. For a PR from anyone you would not let run code on your machine,
  pass `--no-run`: every agent reads, nothing executes.
- **Subagents run on Opus by default**, whatever model the session is on. The session
  model orchestrates; Opus finds and refutes. A project config's `model`, or
  `model: 'sonnet'` in `args`, for a cheaper run.
- Subagents inherit the session's **effort** level — on a high-effort session, every
  agent runs at that effort, and costs accordingly.
- **What it cannot see.** It reviews the diff at its head, PR or branch, not the merged result
  or a sequence of PRs deploying separately — a two-step migration is a property of two
  changes in order, and needs a person.
- **Other agents.** The runner (`runner/review.mjs`) is the reference for what §1–§2 and
  §5–§6 describe here; `--agent codex`, `--agent gemini` and `--agent copilot` are
  experimental, and the README's capability matrix says what each CLI enforces.
- **The angles are the review.** The eight generic angles are a floor. A project's own
  angles — written from the defects it has actually shipped — are what make a review
  find the next one. When a review misses a class of bug that later bites, add an angle
  for it to `.claude/adv-review.json`.
