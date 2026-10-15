# adv-review

[![tests](https://github.com/YahampathChandika/adv-review/actions/workflows/test.yml/badge.svg)](https://github.com/YahampathChandika/adv-review/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/YahampathChandika/adv-review)](https://github.com/YahampathChandika/adv-review/releases)
[![licence](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
![agents](https://img.shields.io/badge/agents-Claude%20Code%20%7C%20Codex%20%7C%20Gemini-informational)

Adversarial review of pull requests and branches, for [Claude Code](https://code.claude.com)
and, experimentally, for OpenAI Codex and Google Gemini through a standalone runner.
A scout designs the review for the specific change, one agent per angle hunts independently, the
findings are grouped by root cause, and every root cause is handed to a skeptic whose
job is to refute it. The report contains only what survived that attempt, labels
anything that could not be verified, and names who found and who checked each finding
and at which commit.

On a public calibration set of 21 PRs with 18 planted defects, the 0.4.0 release
confirmed 17 and wrongly refuted none. Every finding it confirmed was true, and the four
clean PRs drew no findings. See [Calibration](#calibration).

## Quick start

1. **Requirements.** Claude Code on a paid plan with dynamic workflows enabled (on
   Pro, the **Dynamic workflows** row in `/config`), the [GitHub CLI](https://cli.github.com)
   signed in to the repository's host, and git 2.5 or later.
2. **Install.**
   ```bash
   claude plugin marketplace add YahampathChandika/adv-review
   claude plugin install adv-review@yahampathchandika
   ```
3. **Exclude the worktrees from your editor.** Add `**/.claude/worktrees` to the file
   watcher and search exclusions. A long run creates one worktree per agent inside the
   open folder.
4. **Run a review** from a session in the repository:
   ```
   /adv-review:review 140
   ```
   For a branch with no pull request yet, `/adv-review:review --branch`. The first run
   asks for permission to run the workflow. A review takes roughly fifteen minutes to an
   hour and runs in the background; `/workflows` shows progress.
5. **Read the report.** Findings are listed most severe first, each with the failure the
   skeptics could not refute. The session then asks whether to post a summary comment on
   the PR. Nothing is posted, committed or pushed without your confirmation.

Optionally, add a `.claude/adv-review.json` with the project's install and test commands
and its own review angles. See [Configuration](#configuration). To run the review with
Codex or Gemini, or from CI, see [Agents and models](#agents-and-models).

## Contents

- [How it works](#how-it-works)
- [Angles](#angles)
- [Installation](#installation)
- [Agents and models](#agents-and-models)
- [Usage](#usage)
- [Configuration](#configuration)
- [Cost and footprint](#cost-and-footprint)
- [Limitations](#limitations)
- [Security](#security)
- [Calibration](#calibration)
- [Development](#development)
- [Background](#background)
- [Licence](#licence)

## How it works

A review is a [dynamic workflow](https://code.claude.com/docs/en/workflows) of up to 20
subagents by default, each in its own disposable git worktree of the repository at the
PR's head commit. It runs in five phases.

| Phase | Agents | What happens |
| :- | :- | :- |
| Scout | 1 | Reads the diff and the surrounding files, runs the project's own checks on the PR's head, then designs the review: drops the angles this diff cannot trip, with a reason each; points the kept angles at the code that could fail; adds angles specific to this PR; ranks them. |
| Review | 1 per angle | Each finder hunts its angle alone, blind to the others. A finding must state a concrete failure: inputs or state, and the wrong outcome. Style is not a finding. A test that cannot fail is reported as evidence on the defect it hides, not as a finding of its own, and not at all when the code under it is correct. |
| Triage | 1, plus 1 when needed | Groups findings by root cause, so a defect reported at six call sites is verified once. When separate groups sit at the same place in the code, a same-site check rules whether they are one defect or several. |
| Verify | 1 per 4 root causes | Each root cause goes to a skeptic instructed to refute it. An unsure verdict counts as refuted. Critical and high root causes get a three-lens panel (reachable? mechanism right? consequence real?) decided by majority. |
| Synthesis | 1 | A critic asks what no angle would have caught, and is told what the scout ruled out so a wrong drop is visible. |

The result records, for every finding: severity, file and line, the angle that found
it, the skeptics that checked it, the commit reviewed, and whether it was confirmed
cleanly or only after a correction or downgrade. Each finding states whether the PR
introduced the defect or it already existed on the base commit; pre-existing findings
are reported separately and left out of the posted comment unless requested. Refuted
findings are returned with the reason, and those dismissed for doubt alone (no skeptic
could show them false, every skeptic was unsure) are marked for a person to review. An
agent that dies mid-run is retried once while the agent ceiling has room.

## Angles

Eight generic angles ship with the plugin. The scout may rule any of them out, but only
with a stated reason; an angle it did not rule out is guaranteed to run or to be named
as cut.

| Angle | Looks for |
| :- | :- |
| `correctness` | Off-by-one errors, inverted conditions, null paths, unawaited promises, swallowed errors |
| `tests-that-dont-test` | Tests that let a wrong change through: vacuous assertions, snapshots accepted wholesale, tests weakened or deleted so a change passes |
| `boundary-contract` | Callers of a changed signature, consumers of a changed shape, values crossing an API, queue, row or file |
| `silent-drops` | Values written but never stored or read back: stripped keys, read-only attributes, fields renamed on one side only |
| `authz-and-attribution` | Authorisation before the first observable effect; identity re-derived server-side; machine writes not attributed to a person |
| `security` | Injection, secrets in code or logs, unsafe redirects, SSRF, over-broad CORS, data sent where it should not go |
| `data-integrity` | Last-write-wins, missed invalidation, non-idempotent retries, two stores disagreeing, unbounded growth |
| `migrations-and-rollout` | Additive-first migrations, old code against new data during rollout, deferred removals, possible rollbacks |

The generic angles are a baseline. A project's own angles, written from the defects it
has actually shipped, are what find the next one; see [Configuration](#configuration).

## Installation

**Requirements**

- Claude Code with dynamic workflows (available on all paid plans; on Pro, enable the
  **Dynamic workflows** row in `/config`).
- The [GitHub CLI](https://cli.github.com), signed in to the repository's host, for
  pull-request reviews. A branch review needs only git.
- git 2.5 or later, for worktrees.

**Install from the marketplace**

```bash
claude plugin marketplace add YahampathChandika/adv-review
claude plugin install adv-review@yahampathchandika
```

**Load for one session from a clone**

```bash
claude --plugin-dir ./adv-review
```

**Platform.** The plugin path runs on Claude Code's workflow runtime, so it does nothing
on claude.ai or in Cowork. Other agents, and CI, use the standalone runner below.

**Other agents (experimental)**

The skill follows the open Agent Skills format, and the same review runs with the OpenAI
Codex CLI or the Google Gemini CLI through `runner/review.mjs`. Clone this repository,
then either symlink the skill into a place the agent reads skills from, or point the
runner at the clone:

```bash
git clone https://github.com/YahampathChandika/adv-review.git
ln -s "$PWD/adv-review/skills/review" .agents/skills/adv-review   # Codex and Gemini both read .agents/skills
export ADV_REVIEW_HOME="$PWD/adv-review"                           # or this, for the skill to find the runner
```

The agent's own CLI must be installed and signed in: `npm install -g @openai/codex` and
`codex login`, or `npm install -g @google/gemini-cli` and `gemini` once. The runner needs
Node 20 or later and git, and `gh` for pull requests; it is for macOS and Linux. The
symlink keeps the runner reachable from the skill; a copy of the skill folder alone
does not include it.

## Agents and models

A review has two layers. The **session** is what you type the command into: it resolves
the pull request, launches the review and reports. The **agents** do the reviewing: the
scout, the finders, triage, the skeptics and the critic. With the plugin, the session is
Claude Code and the agents run on Claude Code's workflow runtime. With the runner, the
session is `node runner/review.mjs` and each agent is a headless CLI process, in its own
git worktree, of the CLI you choose:

```bash
node runner/review.mjs 140                          # Claude agents, Opus by default
node runner/review.mjs 140 --agent claude --model sonnet
node runner/review.mjs 140 --agent codex            # GPT, whatever Codex defaults to
node runner/review.mjs 140 --agent codex --model gpt-5.5
node runner/review.mjs --branch --agent gemini      # the current branch, Gemini agents
```

`--agent` picks the vendor and `--model` the model within it. The `model` key of
`.claude/adv-review.json` names a Claude model and applies to Claude agents only. The
runner is also the way to run the review from CI or with an API key, since it needs no
interactive session. Run it from a terminal: inside a Codex session, Codex's sandbox would
cut the agents off from the network.

| | Claude Code (plugin) | Claude (runner) | OpenAI Codex (runner) | Google Gemini (runner) |
| :- | :- | :- | :- | :- |
| How to run | `/adv-review:review …` | `runner/review.mjs … --agent claude` | `… --agent codex` | `… --agent gemini` |
| From inside the agent's session | yes | yes (Claude Code) | no: run from a terminal | yes |
| Review runs | yes | yes | yes; the bundled `codex-cli` of the ChatGPT app serves when none is on PATH | yes, untested against a real Gemini CLI |
| Parallel agents | up to min(16, CPUs − 2) | `--jobs`, default up to 6 | `--jobs`, default 3 | `--jobs`, default 3 |
| Worktree isolation | yes, under `.claude/worktrees` | yes, under the system temp dir | yes, temp dir | yes, temp dir |
| Structured answers enforced | by the runtime | by the CLI (`--json-schema`) | by the CLI (`--output-schema`) | no: asked for in the prompt, checked by the runner, one retry |
| `--no-run` enforced | by the prompt | restricted mode: read tools plus read-only git commands, everything else denied | OS sandbox, read-only | by the prompt and headless denial of unapproved tools |
| Runs the project's tests | yes | yes | yes, sandboxed; no network, not even a listening socket, unless `--network` | yes, unsandboxed |
| Posting | the session asks; `--post` | `--post` via `gh` | same | same |
| Resume after a lost agent | yes | no: rerun | no | no |
| Cost visibility | the session's usage | dollars per agent | tokens | tokens, partial |
| Calibration | 0.4.0: 17 of 18 on both sets | sample pending | sample pending | not run: no Gemini plan |
| Status | supported | supported | experimental | experimental |

Runner options beyond the skill's: `--jobs N` agents at once, `--timeout MIN` per agent
(default 30), `--repo PATH`, `--keep-worktrees`, `--dry-run` (prepare and print the
workflow arguments, run nothing), `--network` (Codex: allow network in the sandbox),
`--max-turns N` and `--budget-usd X` (Claude, per agent), `--claude-permission-mode
acceptEdits|auto`, `--allow-workspace-config` (Gemini: review a repository that carries
its own `.gemini/` settings). `node runner/review.mjs --help` lists them all.

## Usage

Run from a session in the repository, on any branch.

| Command | Reviews |
| :- | :- |
| `/adv-review:review` | the PR for the current branch |
| `/adv-review:review 140` | PR 140 |
| `/adv-review:review 136 140` | a stack, as one body of work (140 built on 136) |
| `/adv-review:review --branch` | the current branch against its base, with no pull request |
| `/adv-review:review --branch NAME` | that branch against its base |

| Option | Effect |
| :- | :- |
| `--base REF` | with `--branch`, what the branch is measured against; default the remote's default branch |
| `--agents N` | the most agents the run may use; see [The agent ceiling](#the-agent-ceiling) |
| `--model NAME` | the subagents' model for this run, overriding the project config and the Opus default |
| `--no-run` | agents read the code but execute none of it; see [Security](#security) |
| `--post` | post the summary comment without asking; pull requests only |
| `--out PATH` | also write the result JSON to a file |
| `--include-preexisting` | include pre-existing findings in the posted comment |

**During a run.** The first run asks for permission to run the workflow and shows its
phases. The run then continues in the background; `/workflows` shows each agent's
progress and token use, and the run can be stopped there at any time. When it finishes,
the session reports the findings, removes the agents' worktrees, and asks whether to
post a summary comment on the PR. Nothing is posted, committed or pushed without your
confirmation.

### The agent ceiling

`--agents` is the most a run may spend, not a quota. A small PR stops at six or seven
agents; a large one reaches the ceiling. About 30% of the ceiling is held back so that
what the finders report can be verified. With no number given, the run takes the
smallest ceiling with room for every fixed angle and two of the scout's own (20 for the
generic eight, more for a project with its own angles) and logs its choice. If a given
ceiling is too low to run every angle the scout kept, the run names the angles it cut
and the ceiling that would have run them, and reports itself **incomplete**. Partial
coverage is never reported as complete.

## Configuration

Add `.claude/adv-review.json` at the repository root. Every key is optional. A starting
point is in [`examples/adv-review.json`](examples/adv-review.json).

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

| Key | Purpose |
| :- | :- |
| `install` | Installs dependencies in a fresh worktree. Agents run it before executing anything. If omitted, agents infer it from the lockfile and README. |
| `checks` | The project's typecheck, lint and test command. The scout runs it on the PR's head; a failure in code the diff touches becomes a finding and is verified like any other. If omitted, the scout looks for the project's own scripts. |
| `isolate` | Re-runs one test file alone; `<file>` is substituted. A failure that passes alone is reported as load-induced rather than as the PR's. |
| `agents` | The default ceiling for this project, used when `--agents` is not given. If omitted too, the run computes a ceiling that fits the project's angles. |
| `model` | The subagents' model. Default `opus`. `--model` overrides it for one run. |
| `angles` | The project's own angles, each with a `title` (kebab-case) and a `brief`. A project angle with the same title as a generic one replaces it. |

**Writing an angle.** Add one when a review misses a class of bug that later causes
harm. A brief describes a failure shape and where to look, not a conclusion: what has
gone wrong before, where it hides, and what input to build to prove it. The examples
above are the form to follow.

## Cost and footprint

- **Tokens and time.** A run spawns many Opus agents. Expect a review to cost several
  times what reading the PR in conversation would, and to take between fifteen minutes
  and two hours, most of it agents running the project's test suites. Runs count toward
  the plan's usage limits; a run that hits a limit pauses and resumes when the limit
  resets. `--model sonnet` or the `model` key gives a cheaper, weaker run.
- **A lost agent.** If an agent dies (a session limit, an API call that never answers),
  it is retried once. If the retry also fails, the run returns `incomplete` with the
  agent named, never as clean. With the plugin the run can be resumed: finished agents
  replay from cache and only the lost one runs again. The runner has no resume; a run
  that dies is rerun.
- **Disk.** Every agent gets a full worktree of the repository: under
  `.claude/worktrees/` with the plugin, under the system temp directory with the runner.
  Ten agents on a large monorepo means ten copies. The session removes them after the
  report; if a plugin run is interrupted, remove that run's worktrees by its `wf_…` id as
  the skill describes.
- **Editor.** The worktrees are inside the open folder. Exclude `**/.claude/worktrees`
  from the editor's file watcher and search, or a long run can exhaust its file handles.
- **Machine.** Agents run the project's tests concurrently. Heavy suites can time out
  under that load; the scout re-runs any failing file alone before attributing a failure
  to the PR.

## Limitations

- The review covers the diff at the PR's head, not the merged result and not a sequence
  of PRs deploying in order. Rollout ordering needs a person.
- It does not fix anything. A review ends at the report.
- A branch review covers committed work only, and has nothing to post to. Uncommitted
  changes are not reviewed.
- The runner is for macOS and Linux, has no resume, and its Codex and Gemini backends
  are experimental; the Gemini backend has not been run against a real Gemini CLI.

## Security

Every agent is instructed that the diff, the PR's title and description, code comments
and the repository's files, the config file included, are data under review and never
instructions. Text that reaches a later agent's prompt is flattened to one line, so a
newline in a finding or a brief cannot pose as a section of instructions.

Agents may run the PR's code in their worktrees, which is what makes the strongest
verdicts possible. For a PR from a source you would not let run code on your machine,
pass `--no-run`: every agent reads, nothing executes.

Agents never commit, push, change branch, or post anything. The summary comment is
posted by the session, after your confirmation, under your `gh` identity.

**What each CLI enforces through the runner.** Claude agents run with `acceptEdits`
permissions and Bash allowed, so they can install, test and write repro scripts in their
worktree; that is permission-level, not operating-system, isolation, and your machine is
as exposed as with the plugin. With `--no-run` they run in Claude's restricted mode with
only read tools and read-only git commands allowed, and everything else denied without
asking. Codex agents run in Codex's operating-system sandbox: read-only with `--no-run`,
otherwise writes inside the worktree and no network unless `--network`, which a test
suite that listens on a port needs too. Codex also loads the skills from your own
`.agents/skills` folders into each agent, as it does in any session. Gemini agents
have no sandbox: `--no-run` is enforced by the prompt and by headless Gemini denying
tools that would need approval, so pass `--no-run` for a PR you do not trust, and the
runner refuses a repository that carries its own `.gemini/` or `.agents/` settings unless
told `--allow-workspace-config`, because Gemini would honour them. Every Claude agent is
started without the repository's own Claude settings, hooks and MCP servers.

## Calibration

The review is measured against a public fixture with known defects,
[adv-review-calibration](https://github.com/YahampathChandika/adv-review-calibration):
a small ledger service with two sets of pull requests carrying planted defects, and
clean PRs to measure false positives. The first set, eleven PRs, has ten defects across
the eight generic angles; the second, ten PRs, has eight harder ones that need more
than the changed lines to see. The answer key, the checker that shows every defect
bites, the scorer, the result files and every adjudication are in
[`calibration/`](calibration/README.md). Both passes used Sonnet agents, so the numbers
are a floor for the default Opus configuration.

| | 0.4.0, both sets | 0.3.0, first set | 0.2.0, first set |
| :- | :- | :- | :- |
| Planted defects confirmed | 17 of 18, none wrongly refuted | 10 of 10 | 10 of 10 |
| Confirmed findings true | 33 of 33 | 15 of 15 | 20 of 25 |
| Findings on the clean PRs | none, on four | none, on two | 3, all false, on two |
| Agents per PR | 3 to 20 | 3 to 18 | 7 to 20 |
| Time per PR | 10 to 35 minutes | 15 to 28 minutes | 13 to 28 minutes |

On the first set, 0.4.0 confirmed 9 of 10. No finder opened the file of the one it
missed; the critic named it, but the critic's gaps are not verified. All eight defects
of the second set were confirmed.

The 0.2.0 false positives were all notes on weak tests over correct code; 0.3.0 made a
blind test evidence on the defect it hides rather than a finding of its own.

Through the runner, a four-PR sample (#4, #7, #14 and #11) is recorded per agent under
`calibration/results/0.5.0-<agent>/`; the capability matrix above carries the result.

## Development

The workflow script's tests exercise every failure path (dead agents, a wrong commit, a
forged claim, a ceiling too low) with scripted stand-ins for the agents, so no agent is
spent:

```bash
node --test
```

`tests/runner.test.mjs` exercises the standalone runner with `tests/fixtures/fake-cli.mjs`
standing in for every CLI, so no model is called there either. `evals/review-smoke` is a
`claude plugin eval` case that runs one real review from a fresh clone of the fixture. It
is slow, spends agents, and needs `--scaffold` and `--allow-tools`; see its `case.yaml`.
`calibration/run.sh` runs the full calibration pass through the plugin path and
`calibration/bench.sh` a sample through the runner; `calibration/README.md` describes both.

Repository layout:

| Path | Contents |
| :- | :- |
| `skills/review/SKILL.md` | The skill: how the session resolves the PR, launches the workflow and reports |
| `workflows/adversarial.js` | The workflow script: phases, prompts, budget, grouping and verification |
| `runner/` | The standalone runner: the same script with Claude, Codex or Gemini CLI processes as agents |
| `tests/` | Tests for the workflow script, the runner and the calibration scorer |
| `calibration/` | Answer key, scorer, runners and recorded results |
| `evals/` | The plugin eval case |
| `examples/` | A sample project configuration |

## Background

The adversarial method behind this plugin, independent reviewers whose findings must
survive a reviewer told to refute them, was introduced to the author by
[r3core](https://github.com/r3core). The ratios the plugin uses (30% of the agent
ceiling held back for verification, four root causes per skeptic, a panel for anything
high or critical) came from running it on real pull requests and keeping what worked,
and were then checked against the calibration set.

## Licence

MIT. See [LICENSE](LICENSE).
