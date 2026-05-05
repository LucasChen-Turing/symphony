---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team_key: SYM
  active_states:
    - Todo
  terminal_states:
    - Done
    - Canceled
    - Cancelled
    - Duplicate
  labels:
    - codex
  limit: 1

workspace:
  root: ./.workspaces

git:
  enabled: true
  repo: https://github.com/LucasChen-Turing/symphony.git
  allowed_repos:
    - https://github.com/LucasChen-Turing/symphony.git
  base_branch: lucas/build-symphony-app
  branch_prefix: symphony
  validation_command: cd apps/symphony-ts && npm test && npm run build
  commit_author_name: Symphony
  commit_author_email: symphony@example.local

github:
  create_pr: true
  draft: true
  remote: origin

linear:
  writeback: true
  running_status: In Progress
  review_status: In Progress

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
  turn_timeout_ms: 3600000
  read_timeout_ms: 10000
  stall_timeout_ms: 300000
---

You are working on Linear issue {{ issue.identifier }}.

Title:
{{ issue.title }}

Description:
{{ issue.description }}

Rules:
- Work only inside this repository.
- Keep the change minimal and directly related to the issue.
- Do not push, commit, create pull requests, or update Linear yourself. Symphony performs the handoff after your turn completes.
- Symphony will run the configured validation command after your turn.
- Summarize important implementation notes in your final response.
