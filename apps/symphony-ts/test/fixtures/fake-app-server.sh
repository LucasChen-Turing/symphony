#!/usr/bin/env bash
set -euo pipefail

IFS= read -r initialize_request
if [[ "$initialize_request" != *'"method":"initialize"'* ]]; then
  printf 'expected initialize request\n' >&2
  exit 1
fi
printf '{"id":1,"result":{"userAgent":"fake-codex","codexHome":"/tmp/fake-codex-home","platformFamily":"unix","platformOs":"linux"}}\n'

IFS= read -r initialized_notification
if [[ "$initialized_notification" != *'"method":"initialized"'* ]]; then
  printf 'expected initialized notification\n' >&2
  exit 1
fi

IFS= read -r thread_request
if [[ "$thread_request" != *'"method":"thread/start"'* || "$thread_request" != *'"dynamicTools"'* || "$thread_request" != *'"linear_graphql"'* ]]; then
  printf 'expected thread/start with linear_graphql dynamicTools\n' >&2
  exit 1
fi
printf '{"id":2,"result":{"thread":{"id":"thread-1","preview":"","ephemeral":true,"modelProvider":"fake","createdAt":1,"updatedAt":1,"status":"running","cwd":"%s","turns":[]},"model":"fake-model","modelProvider":"fake","serviceTier":null,"cwd":"%s","instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite","writableRoots":["%s"],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"reasoningEffort":null}}\n' "$PWD" "$PWD" "$PWD"

IFS= read -r turn_request
if [[ "$turn_request" != *'"method":"turn/start"'* ]]; then
  printf 'expected turn/start request\n' >&2
  exit 1
fi
printf '{"id":3,"result":{"turn":{"id":"turn-1","items":[],"status":"inProgress","error":null,"startedAt":1,"completedAt":null,"durationMs":null}}}\n'
printf '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","items":[],"status":"completed","error":null,"startedAt":1,"completedAt":2,"durationMs":1000}}}\n'
sleep 1
