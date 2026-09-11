#!/bin/bash
# Wrapper that runs a test command and treats exit code 77 (skip) as success.
# Exit 77 = ABI mismatch skip (GNU convention), exit 0 = pass, exit 1 = fail.
# Usage: tests/run-test.sh npm run test:integration-happy

if [ "$#" -eq 0 ]; then
  echo "Usage: tests/run-test.sh <test command> [args...]" >&2
  exit 2
fi

# Keep the tests off the ports a running application uses.
#
# On the default 3001 a development app already listening keeps the port; the
# test server quietly falls back to 3002, 3003… while the test still addresses
# 3001 — and reaches the live application instead of its own. It then fails as
# a rejected password rather than a port clash, and its repeated login attempts
# trip the real till's rate limiter, locking the cashier out for fifteen
# minutes. Both are overridable for a machine where these ports are also busy.
export PORT="${PORT:-3901}"
export KDS_PORT="${KDS_PORT:-3911}"

"$@"
exit_code=$?

if [ "$exit_code" -eq 77 ]; then
  echo "  ⏭ Skipped (ABI mismatch)"
  exit 0
fi

exit "$exit_code"
