#!/usr/bin/env bash
# Run calibration reviews headless: one adversarial review per PR, each in its own
# Claude Code session inside a clone of the fixture, the result written by the skill's
# --out into a results folder.
#
#   calibration/run.sh <clone> <results-dir> <pr> [<pr>...]
#
#   <clone>        a clone of the fixture on main, with its GitHub origin; gh must be
#                  signed in to github.com (the skill resolves PRs with it)
#   <results-dir>  where pr-<n>.json lands, e.g. calibration/results/0.3.0
#   MODEL          the agents' model, default sonnet (passed as --model)
#   LANE           a label for the log lines, default lane1
#   MAX_MIN        give up on a PR after this many minutes, default 90
#
# Two lanes: run this twice with disjoint PR lists in two separate clones. Two
# sessions in one clone would contend for its git worktrees.
#
# A print-mode session ends its turn once the workflow is launched, and the
# process then exits and kills the run. So each session reads its prompt from a
# FIFO that stays open until the result file exists and the reporting turn has
# ended, which the stream shows as the second "result" event.
set -u
clone=${1:?clone path}; results=${2:?results dir}; shift 2
[ $# -gt 0 ] || { echo "no PRs given" >&2; exit 2; }
PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
MODEL=${MODEL:-sonnet}
LANE=${LANE:-lane1}
MAX_MIN=${MAX_MIN:-90}
results="$(cd "$(dirname "$results")" && pwd)/$(basename "$results")"
mkdir -p "$results/logs"
progress="$results/logs/progress-$LANE.log"

[ -d "$clone/.git" ] || { echo "$clone is not a git clone" >&2; exit 2; }
command -v gh >/dev/null || { echo "gh is required" >&2; exit 2; }

results_in() { grep -c '"type":"result"' "$1" 2>/dev/null || echo 0; }

for pr in "$@"; do
  out="$results/pr-$pr.json"
  log="$results/logs/pr-$pr.jsonl"
  : > "$log"
  start=$(date +%s)
  echo "=== PR #$pr start $(date -u +%FT%TZ) [$LANE]" | tee -a "$progress"
  fifo=$(mktemp -u "${TMPDIR:-/tmp}/advcal.XXXXXX"); mkfifo "$fifo"
  (cd "$clone" && claude -p --input-format stream-json --output-format stream-json --verbose \
      --plugin-dir "$PLUGIN" --permission-mode auto < "$fifo" > "$log" 2>&1) &
  pid=$!
  exec 3>"$fifo"
  python3 -c 'import json,sys; print(json.dumps({"type":"user","message":{"role":"user","content":sys.argv[1]}}))' \
    "/adv-review:review $pr --no-post --model $MODEL --out $out" >&3
  # The reporting turn is the second one: the first launches the workflow and ends.
  while kill -0 "$pid" 2>/dev/null; do
    if [ -s "$out" ] && [ "$(results_in "$log")" -ge 2 ]; then break; fi
    if [ $(( ($(date +%s) - start) / 60 )) -ge "$MAX_MIN" ]; then
      echo "=== PR #$pr: no result after $MAX_MIN min — stopping [$LANE]" | tee -a "$progress"; break
    fi
    sleep 10
  done
  exec 3>&-
  rm -f "$fifo"
  # Closing stdin ends the session after its current turn; bound the wait.
  waited=0; while kill -0 "$pid" 2>/dev/null && [ $waited -lt 12 ]; do sleep 10; waited=$((waited+1)); done
  kill -0 "$pid" 2>/dev/null && kill "$pid"
  wait "$pid" 2>/dev/null
  echo "=== PR #$pr done after $(( ($(date +%s) - start) / 60 )) min; result: $([ -s "$out" ] && echo present || echo MISSING) [$LANE]" | tee -a "$progress"
done
