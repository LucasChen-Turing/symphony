# Symphony TypeScript MVP

This is a minimal Symphony-compatible orchestration app implemented with TypeScript and Node.js. It is intentionally small and focused on the core scheduler/runner shape from `SPEC.md`.

## Requirements

- Node.js 22.6 or newer. The project uses Node's built-in TypeScript type stripping, so there are no npm dependencies for this MVP.
- A `WORKFLOW.md` file. The bundled `apps/symphony-ts/WORKFLOW.md` uses the mock tracker and a harmless local command.
- `LINEAR_API_KEY` only when running `tracker.kind: linear`.
- `git` and `gh` only when enabling the optional git/GitHub handoff flow.

## Setup

This app can be dogfooded from Linear through Symphony.

```sh
cd apps/symphony-ts
npm test
npm run build
```

No `npm install` is required because the package has no external dependencies.

## Run

Run one deterministic poll cycle with the bundled mock workflow:

```sh
npm start -- --workflow ./WORKFLOW.md --once
```

Run as a daemon:

```sh
npm start -- --workflow ./WORKFLOW.md
```

The default workflow creates per-issue workspaces under `apps/symphony-ts/.workspaces`. Agent command output is written under each workspace at `.symphony/logs/`.

Run with Linear in read-only mode:

```sh
export LINEAR_API_KEY="lin_api_..."
npm start -- --workflow ./WORKFLOW.linear.md --once
```

For local use, you can avoid repeating `export` by creating `.env.local`:

```sh
cp .env.local.example .env.local
```

Then edit `.env.local`:

```sh
LINEAR_API_KEY=lin_api_...
GH_TOKEN=github_token_or_leave_unset_if_gh_is_already_authenticated
```

`.env.local` is git-ignored and loaded automatically from the current directory or the workflow file directory. Environment variables that are already set in the shell win over `.env.local`.

`npm run dev -- --workflow ./WORKFLOW.md` is equivalent to `npm start` and runs directly from `src/`.

## Tracker Config

Mock mode keeps all issues in `WORKFLOW.md`:

```yaml
tracker:
  kind: mock
  active_states:
    - Todo
  terminal_states:
    - Done
  issues:
    - id: mock-1
      identifier: MOCK-1
      title: Local test issue
      state: Todo
```

Linear read-only mode polls Linear but does not update issues, comments, status, or assignees unless the optional `linear.writeback` block is enabled:

```yaml
tracker:
  kind: linear
  team_key: ENG
  project_slug: optional-project-slug
  active_states:
    - Ready for AI
  terminal_states:
    - Done
    - Canceled
  labels:
    - codex
  limit: 5
```

Linear fields:

- `api_key`: optional literal token or `$VAR_NAME`; defaults to `$LINEAR_API_KEY`.
- `team_key`: optional Linear team key such as `ENG`.
- `project_slug`: optional Linear project slug ID. At least one of `team_key` or `project_slug` is required.
- `active_states`: Linear state names eligible for dispatch.
- `statuses`: accepted as an alias for `active_states` for early experiments.
- `terminal_states`: Linear state names used for startup cleanup and reconciliation.
- `labels`: optional label-name filter.
- `limit`: maximum issues fetched per poll, default `50`.
- `comments_limit`: recent issue comments fetched per issue, default `50`.
- `feedback_max_chars`: maximum prompt characters used for comment feedback, default `4000`.

Read-only Linear mode is meant for one local Symphony process. If `linear.writeback` is disabled, two processes can still dispatch the same issue.

## GitHub PR Handoff

The optional dogfood flow lets Symphony use Linear as the control plane for work in a private GitHub repo:

```yaml
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
  running_status: AI Running
  review_status: AI Needs Review
  failed_status: AI Failed
```

Behavior:

- `git.enabled` clones only the configured `git.repo` into `<workspace>/<issue>/repo`.
- `git.allowed_repos` is an explicit allow-list. If present, `git.repo` must match exactly.
- Symphony checks out a branch like `symphony/SYM-5-title-slug`; it refuses protected names such as `main` and `master`.
- The agent runs inside the cloned repo path, not the empty issue workspace.
- `.symphony/` is added to the clone's local `.git/info/exclude` so prompts and logs are not committed.
- `git.validation_command` runs after the agent turn and before commit.
- If changes exist and validation passes, Symphony commits them.
- If `github.create_pr` is true, Symphony pushes the branch and runs `gh pr create`. PRs default to draft.
- If the issue branch already exists on the remote, Symphony checks out that branch and continues from it instead of recreating the branch from `base_branch`.
- If an open PR already exists for the issue branch, Symphony reuses it instead of creating a duplicate PR.
- If no files changed, Symphony skips commit, push, and PR creation even when the issue has follow-up comments.
- If `linear.writeback` is true, Symphony comments on the Linear issue and best-effort moves it to `AI Running`, `AI Needs Review`, or `AI Failed`.

This flow intentionally does not merge PRs, close Linear issues, or push to `main`.

Review loop:

1. Leave follow-up feedback on the same Linear issue.
2. Move the issue back to an active state configured in `tracker.active_states`.
3. Run Symphony again.

The next run will reuse the existing `symphony/<issue>...` branch and update the same draft PR. Symphony write-back comments include an internal `<!-- symphony:run-report -->` marker; the next run includes only human comments after the latest marker as `issue.feedback_since_last_run_summary`.

Use `WORKFLOW.dogfood.example.md` as the starting point for this repository:

```sh
cp WORKFLOW.dogfood.example.md WORKFLOW.dogfood.md
```

Then edit `git.repo`, `git.allowed_repos`, and Linear state names to match your private repo/workspace.

## Workflow Support

Implemented:

- Load `WORKFLOW.md` from an explicit `--workflow` path or from the current directory.
- Parse optional YAML front matter into a root config object.
- Split the Markdown prompt body into `prompt_template`.
- Resolve defaults for tracker, polling, workspace, hooks, agent, and codex config.
- Resolve `$VAR_NAME` only where the spec allows environment indirection.
- Expand `~` and relative `workspace.root` paths.
- Render `{{ issue.field }}` variables with strict unknown-variable failures.
- Render basic `{% if variable %}`, `{% else %}`, and `{% endif %}` blocks.

The YAML and template support is deliberately narrow. It covers the config and prompt style used by the reference workflow, but it is not a full YAML or Liquid implementation.

## Architecture

- `WorkflowStore`: loads and reloads workflow config by checking file modification time before ticks and retries.
- `Config`: converts raw front matter into typed effective settings and validates dispatch preflight requirements.
- `Tracker`: defines the tracker abstraction. `MockTracker` is implemented for local runs without Linear credentials. `LinearTracker` polls Linear through GraphQL in read-only mode.
- `LinearClient`: sends GraphQL requests to Linear with `LINEAR_API_KEY`-backed auth.
- `Orchestrator`: owns polling, claimed/running/retry state, dispatch sorting, active-run reconciliation, retries, and terminal cleanup.
- `WorkspaceManager`: creates deterministic sanitized workspaces, enforces path containment, and runs workspace hooks.
- `GitWorkspaceManager`: optionally clones an allow-listed repo and prepares a per-issue branch.
- `AgentRunner`: renders the prompt, runs hooks, launches `bash -lc <codex.command>` inside the per-issue workspace, writes logs, and reports structured events.
- `CodexAppServerClient`: experimental JSON-RPC line-protocol client for `codex app-server`, covering initialize, thread start, turn start, turn completion, auto-approval, user-input failure, and a `linear_graphql` dynamic-tool handler.
- `HandoffManager`: optionally runs validation, commits changes, pushes a branch, and creates a draft GitHub PR.
- `LinearWriteback`: optionally comments and updates Linear status after running or handoff.

## Codex Runner Modes

The default MVP mode is plain command execution:

```yaml
codex:
  protocol: command
  command: printf "issue received\n"
```

To move closer to the official Symphony app-server flow:

```yaml
codex:
  protocol: app_server
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    writableRoots: []
    networkAccess: false
    excludeTmpdirEnvVar: false
    excludeSlashTmp: false
```

`protocol: app_server` starts the configured process, sends `initialize`, `initialized`, `thread/start`, and `turn/start`, then waits for `turn/completed` or an error. The implementation also handles unsupported tool calls safely and supports `linear_graphql` when Linear auth is configured. Tool advertisement uses the experimental `thread/start.dynamicTools` field exposed by the installed Codex app-server schema.

`linear_graphql` contract:

- Accepts either `{ "query": "...", "variables": { ... } }` or a raw GraphQL query string.
- Rejects empty inputs, non-object `variables`, and documents with more than one GraphQL operation.
- Sends exactly one operation to Linear using the configured `LINEAR_API_KEY`.
- Returns `success: true` for transport success with no top-level GraphQL errors.
- Returns `success: false` with the GraphQL response body when Linear returns top-level errors.

## Current Limitations

- The app-server client is experimental. It implements the core handshake, dynamic tools, and multi-turn lifecycle, but it does not yet cover the full Codex protocol surface.
- Linear write-back is best-effort and optional. Status updates require `tracker.team_key` so Symphony can resolve state IDs.
- GitHub handoff shells out to local `git` and `gh`; credentials and private repo access must already be configured locally.
- Dynamic reload is mtime-based and applied before ticks/retries; there is no persistent database.
- Reconciliation can abort child commands and app-server sessions, but process cleanup is still minimal.
- The mock tracker is read-only except in tests.
- The template engine only supports simple variable interpolation and `if/else/endif`.

## SPEC.md Mapping

- Sections 5 and 6: workflow loading, front matter parsing, defaults, environment indirection, path resolution, and dispatch validation.
- Sections 7 and 8: in-memory orchestrator state, claim checks, polling, sorting, concurrency, retries, and reconciliation.
- Section 9: sanitized per-issue workspace layout, path safety, lifecycle hooks, and terminal cleanup.
- Section 10: minimal command launch in the issue workspace with prompt construction and event/log reporting.
- Section 11: tracker abstraction with a mock implementation first.
- Section 13: structured operator-visible console logs plus per-run workspace log files.
