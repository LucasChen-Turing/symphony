---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team_key: SYM
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Canceled
    - Cancelled
    - Duplicate
  limit: 1

workspace:
  root: ./.workspaces

agent:
  max_concurrent_agents: 1
  max_turns: 1
  max_retry_backoff_ms: 60000

polling:
  interval_ms: 30000

codex:
  protocol: app_server
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 600000
  read_timeout_ms: 10000
  stall_timeout_ms: 300000
---

You are running a low-risk Symphony E2E test for Linear issue {{ issue.identifier }}.

Issue:
{{ issue.identifier }} - {{ issue.title }}

Your only task:
- Use the `linear_graphql` tool to add one comment to this Linear issue.
- The comment body must be exactly:

Symphony E2E test succeeded.

Rules:
- Do not modify files.
- Do not run git commands.
- Do not create commits.
- Do not create pull requests.
- Do not change the Linear issue status.
- After posting the comment, stop.
