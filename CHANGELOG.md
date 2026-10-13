# Changelog

## Unreleased — 0.2.0

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
