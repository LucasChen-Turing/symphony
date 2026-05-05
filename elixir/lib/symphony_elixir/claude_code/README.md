# ClaudeCode.Runner

`ClaudeCode.Runner` executes Claude Code (`claude`) as a subprocess to handle a single
agent turn. It is the Symphony backend for Claude Code, analogous to
`SymphonyElixir.Codex.AppServer` for the Codex backend.

## How it works

The runner invokes `claude` in `--print` mode, which causes Claude Code to read
a prompt from stdin, run to completion, print its final response to stdout, and
exit. There is no long-running process, no JSON-RPC handshake, and no session
state between turns. Each agent turn starts and stops a fresh `claude` process.

## Difference from the Codex backend

| Aspect | Codex (`AppServer`) | Claude Code (`Runner`) |
|---|---|---|
| Protocol | JSON-RPC 2.0 stream over stdio | `--print` mode, plain stdout |
| Session lifetime | Long-lived (thread + multiple turns) | One process per turn |
| OS-level sandbox | Yes (`thread_sandbox`, `turn_sandbox_policy`) | No sandbox configured by the runner |
| Approval policy | Configurable (`never`, per-rule map) | Controlled by Claude Code permissions flags |
| Tool calls | Dynamic tools via `item/tool/call` RPC | Tool use handled inside the `claude` process |

Because the runner does not configure an OS sandbox, you should rely on Claude
Code's own permission settings (e.g. `--allowedTools`, permission config) to
restrict filesystem and network access when that is required by your deployment.

## Configuration

Add a `claude_code:` block to your `WORKFLOW.md` front matter to configure the
runner. Below is an annotated example:

```yaml
claude_code:
  # Shell command used to launch Claude Code.
  # Must resolve to the `claude` CLI binary.
  command: claude --print

  # Maximum time (ms) to wait for a single turn to complete.
  # Default: 3 600 000 (1 hour)
  turn_timeout_ms: 3600000

  # Maximum time (ms) waiting for any individual line of output.
  # Default: 5 000
  read_timeout_ms: 5000
```

### Minimal example

```yaml
---
claude_code:
  command: claude --print
---
```

### Full example with model selection

```yaml
---
claude_code:
  command: >-
    claude --print
    --model claude-sonnet-4-6
  turn_timeout_ms: 1800000
---
```

## Relation to `AgentRunner`

`SymphonyElixir.AgentRunner` orchestrates multi-turn runs for a Linear issue.
When the workflow is configured with a `claude_code:` block, `AgentRunner`
delegates each turn to `ClaudeCode.Runner` instead of `Codex.AppServer`.
