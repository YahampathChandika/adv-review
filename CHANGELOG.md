# Changelog

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
