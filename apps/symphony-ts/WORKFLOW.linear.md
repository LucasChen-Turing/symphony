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
  limit: 3

workspace:
  root: ./.workspaces

agent:
  max_concurrent_agents: 1
  max_turns: 5
  max_retry_backoff_ms: 60000

polling:
  interval_ms: 30000

codex:
  protocol: app_server
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
---

You are a coding agent working on a Linear issue.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
State: {{ issue.state }}
{% if issue.url %}
URL: {{ issue.url }}
{% endif %}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}
{% if issue.labels %}

Labels: {{ issue.labels }}
{% endif %}
{% if attempt %}

Note: This is continuation attempt {{ attempt }}. Review previous work in the workspace before continuing.
{% endif %}

Work on this issue following these guidelines:
- Make changes directly in this workspace directory
- Use git to commit your work when complete
- Use the `linear_graphql` tool for Linear updates when you need to record progress, blockers, PR links, or handoff notes.
- At the start of work, create or update one concise Symphony workpad comment on the Linear issue.
- When done, update the Linear issue state to reflect progress and include validation evidence in the workpad.
