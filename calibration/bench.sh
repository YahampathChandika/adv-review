#!/usr/bin/env bash
# Benchmark one agent on a sample of the fixture's pull requests through the
# standalone runner, one review per PR, results where the scorer reads them.
#
#   calibration/bench.sh <clone> <agent> [<pr>...]        default PRs: 4 7 14 11
#
#   <clone>   a clone of the fixture on main, with its GitHub origin
#   <agent>   claude | codex | gemini
#   MODEL     the agents' model (Claude: sonnet for comparability; others: the CLI's default)
#   JOBS      agents at once (default: the backend's)
#   MAX_MIN   per-agent timeout in minutes (default 45)
#   EXTRA     more runner flags, e.g. EXTRA="--network" (the default for codex: its
#             sandbox blocks listening sockets, which the fixture's tests need)
#
# Run from a terminal, not from inside an agent session: Codex sandboxes commands
# without network. Results go to calibration/results/0.5.0-<agent>/pr-<n>.json;
# score with `node calibration/score.mjs --results calibration/results/0.5.0-<agent>`.
set -u
clone=${1:?clone path}; agent=${2:?agent}; shift 2
prs=("$@"); [ ${#prs[@]} -gt 0 ] || prs=(4 7 14 11)
PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
results="$PLUGIN/calibration/results/0.5.0-$agent"
[ -n "${EXTRA+x}" ] || { [ "$agent" = codex ] && EXTRA="--network" || EXTRA=""; }
mkdir -p "$results/logs"
for pr in "${prs[@]}"; do
  start=$(date +%s)
  echo "=== PR #$pr start $(date -u +%FT%TZ) [$agent]" | tee -a "$results/logs/progress.log"
  node "$PLUGIN/runner/review.mjs" "$pr" --repo "$clone" --agent "$agent" ${MODEL:+--model "$MODEL"} ${JOBS:+--jobs "$JOBS"} \
    --timeout "${MAX_MIN:-45}" $EXTRA --out "$results/pr-$pr.json" \
    2> "$results/logs/pr-$pr.log" > "$results/logs/pr-$pr.report.txt"
  code=$?
  echo "=== PR #$pr done after $(( ($(date +%s) - start) / 60 )) min; exit $code; result: $([ -s "$results/pr-$pr.json" ] && echo present || echo MISSING) [$agent]" | tee -a "$results/logs/progress.log"
done
