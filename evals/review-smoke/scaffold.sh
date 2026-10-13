#!/usr/bin/env bash
# Scaffold for the review-smoke case: a clone of the calibration fixture on the
# branch of one planted-defect PR, in the run's working directory.
#
# The run's HOME is a temporary one, so gh would have no credentials; the skill
# needs gh to resolve the PR. This copies your gh hosts file into the temporary
# HOME for the run — your own credentials, on your own machine, for one run.
# Nothing is written back.
set -euo pipefail

REPO=https://github.com/YahampathChandika/adv-review-calibration.git
BRANCH=feat/overdraft

git clone --quiet "$REPO" .
git checkout --quiet "$BRANCH"

real_home=$(eval echo "~$(id -un)")
if [ -f "$real_home/.config/gh/hosts.yml" ]; then
  mkdir -p "$HOME/.config/gh"
  cp "$real_home/.config/gh/hosts.yml" "$HOME/.config/gh/hosts.yml"
fi
