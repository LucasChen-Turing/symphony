---
tracker:
  kind: mock
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Canceled
  issues:
    - id: mock-1
      identifier: MOCK-1
      title: Exercise the Symphony TypeScript runner
      description: This local mock issue proves the orchestration loop can run without tracker credentials.
      priority: 1
      state: Todo
      labels:
        - local
polling:
  interval_ms: 5000
workspace:
  root: ./.workspaces
agent:
  max_concurrent_agents: 1
  max_turns: 1
  max_retry_backoff_ms: 30000
codex:
  command: node -e "process.stdin.resume(); process.stdin.on('data', c => process.stdout.write(c));"
  turn_timeout_ms: 30000
  stall_timeout_ms: 0
---

You are working on issue `{{ issue.identifier }}`.

Title: {{ issue.title }}
State: {{ issue.state }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}
