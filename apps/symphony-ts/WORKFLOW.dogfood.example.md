---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team_key: SYM
  active_states:
    - Todo
    - Plan Review
    - In Progress
  terminal_states:
    - Done
    - Canceled
    - Cancelled
    - Duplicate
  labels:
    - codex
  limit: 1
  comments_limit: 50
  feedback_max_chars: 4000

workspace:
  root: ./.workspaces

git:
  enabled: true
  repo: git@github.com:YOUR_ACCOUNT_OR_ORG/symphony.git
  allowed_repos:
    - git@github.com:YOUR_ACCOUNT_OR_ORG/symphony.git
  base_branch: main
  branch_prefix: symphony
  validation_command: npm test && npm run build
  commit_author_name: Symphony
  commit_author_email: symphony@example.local

github:
  create_pr: true
  draft: true
  remote: origin

linear:
  writeback: true
  planning_state: Todo
  plan_review_status: Plan Review
  implementation_state: In Progress
  review_status: AI Needs Review
  failed_status: AI Failed

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

Recent human feedback since the last Symphony run:
{{ issue.feedback_since_last_run_summary }}

Latest Symphony plan:
{{ issue.latest_symphony_plan }}

Human feedback after the latest Symphony plan:
{{ issue.plan_feedback_since_latest_plan_summary }}

Rules:
- Work only inside this repository.
- Keep the change minimal and directly related to the issue.
- If recent human feedback is present, treat it as the latest instruction for this run.
- Run the configured validation command indirectly by finishing the task; Symphony will run validation after your turn.
- Do not push, commit, create pull requests, or update Linear yourself. Symphony performs the handoff after your turn completes.
- Summarize important implementation notes in your final response.

{% if issue.symphony_planning_mode %}
Planning phase:
- Produce only a concise implementation plan.
- If human feedback after the latest plan is present, revise the plan to address it.
- Do not edit files, run validation, commit, push, create pull requests, or update Linear.
- End with the plan only.
{% endif %}

{% if issue.symphony_implementation_mode %}
Implementation phase:
- Implement the latest Symphony plan, adjusted by human feedback after the plan.
- If the latest plan is missing, inspect the issue and proceed with the smallest directly related implementation.
{% endif %}
