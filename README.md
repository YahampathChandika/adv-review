# adv-review

An adversarial pull-request review for [Claude Code](https://code.claude.com). A scout
reads the diff and designs the review; one agent per angle hunts independently; the
findings are grouped by root cause; then every root cause is handed to a skeptic whose
only job is to **refute** it. What you read is what survived an attempt to kill it, and
anything that was never tested is labelled as such rather than passed off as clean.

```
/adv-review:review 219
```

It runs as a [dynamic workflow](https://code.claude.com/docs/en/workflows): up to 20
subagents by default, on Opus, each in its own disposable git worktree of your
repository. It is not cheap, and it is not a linter. It is for the pull request you
would otherwise read three times.

## What a run looks like

1. **Scout** (1 agent): reads the diff and the files around it, runs the project's own
   checks on the PR's head, then designs the review: drops the angles this diff cannot
   trip (with a reason each), points the ones it keeps at the code that could go wrong,
   adds angles specific to this PR, and ranks the lot.
2. **Review** (1 agent per angle): each hunts its angle alone and blind to the others.
   A finding needs a concrete failure — inputs or state, and the wrong outcome. Style
   is not a finding.
3. **Triage** (1 agent): groups findings by root cause, so one defect reported at six
   call sites is verified once.
4. **Verify** (skeptics): each root cause goes to a skeptic told to refute it. *Unsure
   counts as refuted.* Critical and high root causes get a three-lens panel (can it be
   reached? is the mechanism right? does it matter?) decided by majority.
5. **Synthesis** (1 critic): asks what no angle would have caught, and is told what
   the scout ruled out so a wrong drop is visible.

The result names every finding's severity, file and line, who found it, who checked
it, at which commit, and whether it was confirmed cleanly or only after a skeptic
corrected or downgraded it. It says whether the PR introduced each defect or it was
already on the base commit; pre-existing findings are reported apart and left out of
the posted comment unless you ask. Refuted findings are returned too, with the reason,
and those killed for doubt alone — nobody showed them false, every skeptic was unsure
— are marked so a person can glance at them. An agent that dies mid-run is run once
more while the ceiling has room.

## The angles

Eight generic angles ship with the plugin. The scout may rule any of them out, but
only with a stated reason; an angle it did not rule out is guaranteed to run or to be
named as cut.

| Angle | Looks for |
| :- | :- |
| `correctness` | Off-by-one, inverted conditions, null paths, unawaited promises, swallowed errors |
| `tests-that-dont-test` | Tests that pass whether or not the code is right; snapshots accepted wholesale |
| `boundary-contract` | Callers of a changed signature, consumers of a changed shape, values crossing an API, queue, row or file |
| `silent-drops` | Values written but never stored or read back: stripped keys, read-only attributes, renamed-on-one-side fields |
| `authz-and-attribution` | Authorisation before the first observable effect; identity re-derived server-side; machine writes not under a person's name |
| `security` | Injection, secrets in code or logs, unsafe redirects, SSRF, over-broad CORS, data sent where it shouldn't go |
| `data-integrity` | Last-write-wins, missed invalidation, non-idempotent retries, two stores disagreeing, unbounded growth |
| `migrations-and-rollout` | Additive-first migrations, old code against new data during rollout, removals deferred, rollbacks possible |

**The generic angles are a floor.** What makes a review find the next bug is the
project's own angles — written from the defects it has actually shipped. Those go in a
config file, below. The project this was extracted from runs ten of its own, and the
two worst classes of bug its reviews caught were found by angles written after an
earlier review missed them.

## Install

Requires Claude Code with dynamic workflows (all paid plans; on Pro, turn them on from
the **Dynamic workflows** row in `/config`), the [GitHub CLI](https://cli.github.com)
signed in to the repository's host, and git 2.5 or later for worktrees.

```bash
claude plugin marketplace add YahampathChandika/adv-review
claude plugin install adv-review@yahampathchandika
```

Or, for one session, from a clone: `claude --plugin-dir ./adv-review`.

**Claude Code only.** The review runs on Claude Code's Workflow runtime. The plugin does
nothing on claude.ai or in Cowork.

## Use

From a session in the repository, on the PR's branch or any other:

```
/adv-review:review                 the PR for the current branch
/adv-review:review 140             that PR
/adv-review:review 136 140         a stack, reviewed as one body of work
/adv-review:review 140 --agents 30 raise the ceiling for a large PR
/adv-review:review 140 --no-run    read the code, execute nothing
/adv-review:review 140 --post      post the summary comment without asking
/adv-review:review 140 --out r.json  also write the result JSON to a file
/adv-review:review 140 --include-preexisting   post pre-existing findings too
```

The first run asks you to allow the workflow and shows its phases. The run then goes
on in the background; `/workflows` shows each agent's progress and token use, and you
can stop it there at any time. When it finishes, the session reports the findings,
removes the agents' worktrees, and asks whether to post a summary comment on the PR —
nothing is posted, committed or pushed without your yes.

### The agent count is a ceiling

`--agents` is the most a run may spend, not a quota. A small PR stops at six or seven
agents; a large one reaches the ceiling. About 30% is held back so that what the
finders find can be verified. Given no number, the run takes the smallest ceiling with
room for every fixed angle and two of the scout's own — 20 for the generic eight, more
for a project with angles of its own — and logs what it chose. When a ceiling you gave
is too low to run every angle the scout kept, the run says which it cut, names the
ceiling that would have run them, and reports itself **incomplete** — it never reports
partial coverage as complete.

## Configure a project

Add `.claude/adv-review.json` at the repository root. Every key is optional.

```json
{
  "install": "pnpm install --frozen-lockfile --offline --ignore-scripts",
  "checks": "pnpm turbo run typecheck test --output-logs=errors-only",
  "isolate": "npx vitest run <file>",
  "agents": 30,
  "model": "opus",
  "angles": [
    {
      "title": "write-boundary",
      "brief": "Keys that get silently dropped. The section validator strips any key the schema does not declare, so a mapper or prefill that writes an undeclared key looks like it worked and stores nothing. Check every value written in this diff against the schema of the record it targets, and the reverse: a field declared but never written, or written under a name the reader does not read back."
    },
    {
      "title": "cross-tenant-reach",
      "brief": "Which tenant's data can this code read? Uploaded files are scoped to the account, not the project, so a query that filters on account alone reads another project's documents. For every new or widened read, name the other project whose record satisfies it and say where that value lands."
    }
  ]
}
```

| Key | What it does |
| :- | :- |
| `install` | How to install dependencies in a fresh worktree. Agents run it before running anything. Omitted, they work it out from the lockfile and README. |
| `checks` | The project's typecheck/lint/test command. The scout runs it on the PR's head; a failure in code the diff touches becomes a finding and is verified like any other. Omitted, the scout looks for the project's own scripts. |
| `isolate` | How to re-run one test file alone; `<file>` is replaced. A failure that passes alone is reported as load-induced, not as the PR's. |
| `agents` | The default ceiling for this project, used when `--agents` is not given. Omitted too, the run computes one that fits the project's angles. |
| `model` | The subagents' model. `opus` by default. |
| `angles` | The project's own angles: `title` (kebab-case) and `brief`. A brief is a *failure shape and where to look*, not a conclusion — tell the finder to build the input that makes it bite and run it. A project angle with the same title as a generic one replaces it. |

Write an angle when a review misses a class of bug that later bites. The brief should
read like the one above: what has gone wrong before, where it hides, and what to build
to prove it.

## Cost and footprint

- **Tokens and time.** A run spawns many Opus agents. Expect a review to cost several
  times what reading the PR in conversation would, and to take between half an hour and
  two hours, most of it the agents running the project's own test suites. Runs count
  toward your plan's usage limits, and a run that hits a limit pauses and resumes when
  it resets. Set `model` to a smaller model for a cheaper, weaker run.
- **A lost agent.** If an agent dies — the session limit, an API call that never
  answers — the run comes back `incomplete` with that agent named, never as clean. Ask
  to resume it: finished agents replay from cache and only the dead one runs again.
- **Disk.** Every agent gets a full worktree of the repository under
  `.claude/worktrees/`. Ten agents on a large monorepo is ten copies. The session
  removes them after the report; if a run is interrupted, remove that run's worktrees
  by its `wf_…` id as the skill describes.
- **Your editor.** Those worktrees are inside the open folder. Exclude
  `**/.claude/worktrees` from your editor's file watcher and search, or a long run can
  exhaust its file handles.
- **Your machine.** Agents run the project's tests concurrently. Heavy suites time out
  under that load; the scout re-runs any failing file alone before blaming the PR.

## What it does not do

- It reviews the diff at the PR's head, not the merged result, and not a sequence of
  PRs deploying in order. Rollout ordering needs a person.
- It does not fix anything. A review ends at the report.
- It needs a GitHub pull request. Reviewing a local branch without one is not supported
  yet.

## Trust

Every agent is told that the diff, the PR's title and description, code comments and
the repository's files — the config file included — are data under review, never
instructions. Text that reaches a later agent's prompt is flattened to one line so a
newline in a finding or a brief cannot pose as a section of instructions. Agents may run
the PR's code in their worktrees; for a PR from someone you would not let run code on
your machine, pass `--no-run`.

Agents never commit, push, change branch, or post anything. Posting the summary comment
is the session's, after your yes, under your `gh` identity.

## Calibration

The review is measured against a fixture with known defects:
[adv-review-calibration](https://github.com/YahampathChandika/adv-review-calibration),
a small ledger service whose pull requests each carry one planted defect the PR's own
tests miss (two carry none). The answer key and the scorer are in [`calibration/`](calibration/):
run each PR with `--out`, then `node calibration/score.mjs` reports which planted
defects were confirmed, found and then wrongly refuted, or missed, what was reported
that nobody planted, and recall and precision over the set.

The first pass, for 0.2.0 with Sonnet agents: all ten planted defects confirmed and
none wrongly refuted; 20 of 25 confirmed findings true after a person adjudicated the
unplanted ones, the five false being coverage notes on correct code; three findings on
the two clean PRs, all false; 7 to 20 agents and 13 to 28 minutes per PR. The result
files and every adjudication are in [`calibration/`](calibration/README.md#results).

## Tests

The script's own tests run every failure path — dead agents, a wrong commit, a forged
claim, a ceiling too low — with scripted stand-ins for the agents, so no agent is spent:

```bash
node --test
```

`evals/` holds a `claude plugin eval` case that runs one real review from a fresh
clone of the fixture; it is slow and costs agents, and needs `--scaffold` and
`--allow-tools`. See `evals/review-smoke/case.yaml`.

## Origin

Extracted from a private project where it reviewed around fifteen pull requests over
three weeks and confirmed about a hundred defects, most of them after a skeptic had
narrowed the claim. Its angle list there grew from the bugs that shipped; the generic
list here is what survives without that history. The ratios — 30% held back, four root
causes to a skeptic, a panel for anything high — were chosen by what stalled and what
missed, not derived. Calibrate against a PR whose bugs you already know before trusting
the numbers on yours.

## Licence

MIT. See [LICENSE](LICENSE).
