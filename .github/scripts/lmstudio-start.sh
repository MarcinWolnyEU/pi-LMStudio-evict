#!/usr/bin/env bash
# Start the llmster daemon and the API server, and only return once
# ~/.lmstudio/bin/lms has stopped being rewritten.
#
# Why: llmster replaces ~/.lmstudio/bin/lms (unlink, then a fresh copy of the
# CLI bundled with the daemon) while it starts. `lms daemon up` can return
# before that copy is done, and exec'ing a file that is still open for writing
# fails with ETXTBSY ("Text file busy", exit 126) on Linux. It is a race: most
# runs win it. LMS_DAEMON_DISABLE_UPDATES does not stop it. Windows swaps
# lms.exe about five seconds *after* `daemon up` returns, so the wait is for
# the file to change and then hold still, not for a fixed delay.
#
# Usage: lmstudio-start.sh        (needs `lms` on PATH)
set -euo pipefail

lms_bin="$HOME/.lmstudio/bin/lms"
[ -e "$lms_bin" ] || lms_bin="$lms_bin.exe"

CHANGE_TIMEOUT=30   # seconds to wait for the replacement to show up
SETTLE_SECONDS=3    # seconds the file must stay unchanged afterwards
OVERALL_TIMEOUT=90  # hard bound on the whole wait

# size, mtime, ctime, inode. The unlink + copy gives a new inode (and ctime)
# even when the content is identical, which is what we need to see.
identity() {
  stat -c '%s %Y %Z %i' "$lms_bin" 2>/dev/null || stat -f '%z %m %c %i' "$lms_bin" 2>/dev/null || echo missing
}

# Run lms, retrying only when the exec itself failed with ETXTBSY. In that
# case the command never started, so repeating it is safe.
lms_retry() {
  local out rc attempt
  out="$(mktemp)"
  for attempt in $(seq 1 30); do
    # A file, not $(...): `lms daemon up` leaves the daemon holding our stdout.
    set +e
    "$@" > "$out" 2>&1
    rc=$?
    set -e
    cat "$out"
    if [ "$rc" -eq 126 ] || grep -q 'Text file busy' "$out"; then
      echo "::warning::lms is busy (attempt $attempt, exit $rc), retrying in 1s"
      sleep 1
      continue
    fi
    rm -f "$out"
    return "$rc"
  done
  rm -f "$out"
  return 126
}

before="$(identity)"
echo "lms before daemon up: $before"

lms_retry lms --version
lms_retry lms daemon up

up_at=$SECONDS
changed=0
while [ $((SECONDS - up_at)) -lt "$CHANGE_TIMEOUT" ]; do
  if [ "$(identity)" != "$before" ]; then changed=1; break; fi
  sleep 0.5
done
if [ "$changed" = 1 ]; then
  echo "lms was replaced by the daemon $((SECONDS - up_at))s after daemon up: $(identity)"
else
  echo "::warning::lms was not replaced within ${CHANGE_TIMEOUT}s of daemon up; llmster may have stopped doing that"
fi

stable_since=$SECONDS
last="$(identity)"
while :; do
  now="$(identity)"
  if [ "$now" != "$last" ]; then
    echo "lms changed again $((SECONDS - up_at))s after daemon up: $now"
    last="$now"
    stable_since=$SECONDS
  elif [ $((SECONDS - stable_since)) -ge "$SETTLE_SECONDS" ]; then
    break
  fi
  if [ $((SECONDS - up_at)) -ge "$OVERALL_TIMEOUT" ]; then
    echo "::error::lms kept changing for ${OVERALL_TIMEOUT}s"
    exit 1
  fi
  sleep 0.5
done
echo "lms settled $((SECONDS - up_at))s after daemon up: $last"

lms_retry lms --version
lms_retry lms server start
lms_retry lms server status --json
