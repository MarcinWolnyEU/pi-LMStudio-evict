#!/usr/bin/env bash
# Download the chat models the integration suite needs. `lms get` is a no-op
# for a model that is already on disk, so a restored actions/cache hit makes
# this near-instant.
#
# Usage: lmstudio-models.sh <model> [<model> ...]
#
# Needs the llmster daemon up (lms daemon up) and `lms` on PATH.
set -euo pipefail

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# `lms get` repaints a spinner with carriage returns even when not on a TTY,
# which turns a CI log into thousands of lines. Keep the interesting tail.
show_tail() {
  tr '\r' '\n' < "$log" | sed -E $'s/\x1b\[[0-9;?]*[A-Za-z]//g' | grep -v '^[[:space:]]*$' | tail -n "$1"
}

for model in "$@"; do
  echo "::group::lms get $model"
  # --gguf: macOS would otherwise pick the MLX build, which needs Metal.
  # -y: never prompt. Retried because the catalogue resolves through
  # Hugging Face, which rate-limits (HTTP 429) shared CI addresses.
  ok=0
  for attempt in 1 2 3 4; do
    if lms get "$model" --gguf -y > "$log" 2>&1; then
      show_tail 3
      ok=1
      break
    fi
    show_tail 8
    echo "lms get $model failed (attempt $attempt), retrying in $((attempt * 20))s"
    sleep $((attempt * 20))
  done
  echo "::endgroup::"
  if [ "$ok" != 1 ]; then
    echo "::error::could not download $model"
    exit 1
  fi
done
