#!/usr/bin/env bash
# Stub agent for e2e testing.
#
# Reads ARK_SESSION_ID, ARK_STAGE, and ARK_CONDUCTOR_URL (or derives
# conductor URL from ARK_CONDUCTOR_PORT) from the environment, then posts
# a CompletionReport to the conductor's channel HTTP endpoint.
#
# This script replaces the real LLM agent body. Everything before
# (dispatch chain, compute resolution, executor launch) and after
# (conductor report handling, stage advance) stays real.
set -euo pipefail

SESSION_ID="${ARK_SESSION_ID:?ARK_SESSION_ID is required}"
STAGE="${ARK_STAGE:?ARK_STAGE is required}"

# Derive conductor URL from ARK_CONDUCTOR_URL or fall back to ARK_CONDUCTOR_PORT.
if [[ -n "${ARK_CONDUCTOR_URL:-}" ]]; then
  CONDUCTOR_URL="${ARK_CONDUCTOR_URL}"
else
  PORT="${ARK_CONDUCTOR_PORT:-19102}"
  CONDUCTOR_URL="http://localhost:${PORT}"
fi

case "${STAGE}" in
  plan)
    SUMMARY="Plan: implement get_cpu_usage by reading /proc/stat on linux, host_statistics on darwin"
    FILES='[]'
    ;;
  implement)
    SUMMARY="Implementation: added get_cpu_usage to src/sys/cpu.ts"
    FILES='["src/sys/cpu.ts"]'
    ;;
  *)
    SUMMARY="Stub agent completed stage ${STAGE}"
    FILES='[]'
    ;;
esac

# Brief pause to let the tmux pane fully attach (if running via tmux) and
# to mimic the real agent doing some work.
sleep 1

# Post a CompletionReport to the conductor via JSON-RPC `channel/deliver`.
# The legacy REST route POST /api/channel/:sessionId was removed when the
# control plane consolidated on the JSON-RPC surface; agents now go through
# arkd which forwards via the same RPC, but this stub bypasses arkd so we
# call /api/rpc directly.
curl -fsS -X POST "${CONDUCTOR_URL}/api/rpc" \
  -H 'Content-Type: application/json' \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": \"stub-agent-${SESSION_ID}-${STAGE}\",
    \"method\": \"channel/deliver\",
    \"params\": {
      \"sessionId\": \"${SESSION_ID}\",
      \"report\": {
        \"type\": \"completed\",
        \"sessionId\": \"${SESSION_ID}\",
        \"stage\": \"${STAGE}\",
        \"summary\": \"${SUMMARY}\",
        \"filesChanged\": ${FILES},
        \"commits\": []
      }
    }
  }"

exit 0
