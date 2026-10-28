#!/usr/bin/env bash
# Fail unless the node:test summary in the given log reports a clean run:
# at least one test, and zero failed, zero skipped, zero cancelled, zero todo.
#
# `npm test` already exits non-zero on failures; this closes the gap for
# skips and cancellations, which a green exit code can hide.
#
# Usage: check-test-summary.sh <log-file>
set -euo pipefail

log="${1:?usage: check-test-summary.sh <log-file>}"

# The spec reporter ends with lines like "ℹ tests 87". Strip ANSI colour first.
summary="$(sed -E $'s/\x1b\[[0-9;]*m//g' "$log" | tr -d '\r' | grep -E '^ℹ (tests|pass|fail|cancelled|skipped|todo) [0-9]+' || true)"

if [ -z "$summary" ]; then
  echo "::error::no node:test summary found in $log"
  exit 1
fi
echo "$summary"

count() { echo "$summary" | awk -v key="$1" '$2 == key { print $3 }' | tail -n 1; }
tests="$(count tests)"; pass="$(count pass)"; fail="$(count fail)"
cancelled="$(count cancelled)"; skipped="$(count skipped)"; todo="$(count todo)"

status=0
if [ "${tests:-0}" -lt 1 ]; then echo "::error::no tests ran"; status=1; fi
if [ "${pass:-0}" != "${tests:-0}" ]; then echo "::error::pass ($pass) != tests ($tests)"; status=1; fi
for key in fail cancelled skipped todo; do
  value="$(count "$key")"
  if [ "${value:-0}" != "0" ]; then echo "::error::$value test(s) reported as $key"; status=1; fi
done
exit $status
