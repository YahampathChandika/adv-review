---
name: review
description: Adversarial multi-angle review of one or more GitHub pull requests — a scout designs the review, one agent per angle hunts independently, and every root cause is handed to a skeptic told to refute it. Only what survives is reported. Runs many Opus agents; use when asked to adversarially review a PR, review it from multiple angles, or review a stack of PRs together.
argument-hint: "<pr-number>… [--agents N] [--post] [--no-run]"
disable-model-invocation: true
---

# Adversarial PR review

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

## 1. Resolve the target

`/adv-review:review` — the PR for the current branch.
`/adv-review:review 140` — that PR.
`/adv-review:review 136 140` — a STACK reviewed as ONE body of work (140 built on 136):
every PR's diff goes in, and the agents read the tip's commit, which carries them all.
Only for stacks — two PRs that are merely related are two separate reviews.
`/adv-review:review 140` where 140 is stacked on an open 136 — 140's changes only; 136
is out of scope (pass `stackedOn: 136`) and gets its own review.
`--agents N` — the MOST agents the review may use (default 20, or the project's
`agents`; see §3).
`--post` — post the summary without asking at the end (see §6).
`--no-run` — agents read the code but execute none of it (see Notes).

Resolve with `gh`. With no number, `gh pr view --json number` on the current branch.
If `gh` is not installed or not signed in, stop and say so: the review needs it.

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

## 3. The agent count is a ceiling

`--agents N` is the **most** the review may spend, not a quota. The run spends what this
PR needs and says what it used: a finder per angle that applies, triage when there are
findings to group, one skeptic per four root causes, a three-lens panel of skeptics for
each critical or high root cause while the ceiling allows, and the critic. A three-file
PR might use six agents; a 5,000-line one reaches the ceiling.

The order of precedence for the ceiling: `--agents` on the command, then the project
config's `agents`, then 20.

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
ceiling: lower it when usage is running low, raise it for a large or risky PR, or for a
project with many angles of its own (eight generic angles plus the project's need
roughly `(angles + 2) / 0.7 + 2` agents to all run). Do not choose a number for them.

A run that hits the session limit part-way comes back `incomplete`, with the dead agents
named. After the limit resets, resume it — completed agents replay from cache for free:
`Workflow({ scriptPath, resumeFromRunId, args })` with the same `args`.

## 4. Launch

The workflow ships with this plugin as `adv-review:adversarial`. Launch it by name:

```
// One PR:
Workflow({
  name: 'adv-review:adversarial',
  args: { prs: [137], title: '…', intent: '…', diffs: ['/abs/path/pr-137.diff'],
          agents: 20, headSha: '<137 headRefOid>',
          project: { /* the contents of .claude/adv-review.json, if any */ } }
})
// A whole stack, as one body of work:
//   args: { prs: [136, 140], diffs: ['/abs/pr-136.diff', '/abs/pr-140.diff'],
//           headSha: '<140 headRefOid>', … }
// One PR of a stack, its base out of scope:
//   args: { prs: [140], diffs: ['/abs/pr-140.diff'], stackedOn: 136,
//           headSha: '<140 headRefOid>', … }
```

If the runtime does not resolve the name, pass the script's path instead:
`scriptPath: '${CLAUDE_PLUGIN_ROOT}/workflows/adversarial.js'`.

`args` must be a real JSON object. `agents` a whole number (or a numeric string),
`headSha` the head commit from §2, and `project` an object with the shape the README
gives; a bad value of any of these stops the run before any agent starts.
Add `run: false` for `--no-run`, and `model` only to override Opus (the project config's
`model`, if set, is the override to pass).

The workflow runs in the background and you are notified when it finishes. Do not poll
it, and do not start a second review while one is running.

## 5. Report

The result is:

```
{ status: 'complete' | 'incomplete', incomplete: [reasons],
  headSha, confirmed, refuted, unverified, missed,
  counts: { raw, rootCauses, confirmed, plausible, corrected, downgraded, refuted, unverified },
  budget: { ceiling, used, scout, finders, triage, skeptics, critic },
  angles, projectAngles, droppedAngles, notRun, failedAngles, baseline, scoutNotes }
```

and the tool result also carries the run's `logs`.

**If `status` is `incomplete`, say so first**, with the reasons — before any finding. An
incomplete run is never reported as clean, and `missed: null` means the critic did not
run: coverage is unknown, not complete.

Report `confirmed`, most severe first. If a `ReportFindings` tool is available, use it
— each finding with `file`, `line`, a one-sentence `summary`, and the `failure_scenario`
the skeptics could not refute — and do not also print the findings as prose. Without
that tool, print one table: severity, `file:line`, summary, the failure. Either way:
use the finding's own `severity` and `summary` (where a skeptic corrected them, those
are the corrected ones); `verdict` is `CONFIRMED` where every skeptic upheld it with
confidence and `PLAUSIBLE` where a panel split 2–1 or a skeptic was unsure; a finding
with several `sites` is one defect in several places — say so in its summary.

Then, in a few lines:
- the budget: "used X of N" and why, from `budget` and the logs;
- the angles run, and any the scout dropped or the ceiling cut;
- the verification: how many root causes were refuted, and how many upheld only after
  correction or a downgrade — a downgrade is not a clean confirmation;
- everything in `unverified` and `missed`, for a person to check by hand. Neither has
  survived a refutation, and neither may be presented as if it had.

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
2. **Ask whether to post** — one summary comment (`gh pr comment`) or inline comments.
   Post only on the user's yes for THIS review, or when they passed `--post`. A posted
   comment names the head commit it reviewed (`headSha`), and flags anything unverified.
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
- **What it cannot see.** It reviews the PR's diff at its head, not the merged result
  or a sequence of PRs deploying separately — a two-step migration is a property of two
  changes in order, and needs a person.
- **The angles are the review.** The eight generic angles are a floor. A project's own
  angles — written from the defects it has actually shipped — are what make a review
  find the next one. When a review misses a class of bug that later bites, add an angle
  for it to `.claude/adv-review.json`.
