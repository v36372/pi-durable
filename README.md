# Durable Agent

Open https://v36372-agent.exe.xyz with your exe.dev account.
The application runs on v36372-agent, a private VM from ghcr.io/boldsoftware/exeuntu:latest.

This prototype gives one owner persistent conversations, code tools, and editable extensions.
The agent works in its own repository. It can change tools, its browser interface, and its server.
The initial tools are read, write, edit, bash, and restart. Extension and UI edits apply automatically.
MCP and codemode remain absent for the first self-modification tests.

## Try it

1. Ask: "Read AGENTS.md and docs/extensions.md. List your current tools."
2. Ask for one small extension. Require a test and an invocation of the new tool.
3. Open Session to confirm the registry updates automatically. The conversation remains intact.
4. Ask for MCP or codemode when you want the next experiment.

## Chat interface

Use New conversation for an empty transcript. Session contains a conversation selector, runtime details, the registry, and diagnostics.
Model and Effort controls apply per conversation. Choices include known OpenAI chat models from the configured gateway.
Each model offers only its supported effort levels. Changes apply to the next model request, not a request already in progress.
Conversations retain their transcripts and settings across process restarts. All conversations share the same workspace, tools, and VM permissions.
Per-tab drafts remain separate when you switch conversations. An unacknowledged message must complete before you switch.
The single-column chat uses square controls and collapses tool activity into work groups.
Expand a work group for tool inputs, outputs, and errors.
Agent replies support headings, lists, bold text, inline code, code blocks, and HTTP links. Raw HTML remains plain text.
Tables and nested Markdown remain outside this renderer's scope.

## Local use

Requires Linux, Node 24 or later, and access to an exe.dev LLM integration.

```sh
npm ci --ignore-scripts
npm test
npm start
```

Open http://127.0.0.1:8787. The default model is gpt-5.5 through https://llm.int.exe.xyz/v1.
Set LLM_BASE_URL for another compatible OpenAI gateway. LLM_MODEL sets the default model for new installations.
If gateway discovery fails, only the default model appears in the selector until the next process restart.
Set AGENT_ORIGIN to the exact browser origin for remote use. Keep the proxy private.
AGENT_STATE_DIR defaults to ~/.local/state/durable-agent. PORT defaults to 8787.

## Implementation

- src/agent.mjs: Pi Durable harness, SQLite, prompt, code tools, restart coordination.
- src/extensions.mjs: automatic reload with validation before registry changes.
- src/server.mjs and src/http.mjs: one private HTTP API with origin and body validation.
- web/: plain JavaScript and CSS. The browser reads committed state every second and refreshes after UI edits.
- test/: code-tool, deduplication, extension, HTTP boundary, and SIGKILL recovery checks.

See docs/extensions.md for the extension contract and AGENTS.md for the agent's change procedure.

## Durability and limits

Pi Durable commits conversation and task state to SQLite. The host enables WAL and synchronous=FULL.
Systemd restarts the process after exit. Pi resumes pending work.
The startup script holds an exclusive process lock. Do not bypass it against the live database.
Settled tools do not repeat. Interrupted unsafe tools return errors. Only replay-safe tools automatically execute again.
External effects require their own idempotency. SQLite cannot make a remote request atomic with its transcript commit.
Partial streamed output can lose the most recent second after a crash.

One VM is not a replicated service. Disk loss loses state. No off-VM backup exists.
The UI shows at most 200 active entries. Older entries remain in SQLite, including history before context compaction.
There is no history browser, multi-user isolation, extension sandbox, or automatic source rollback.
The agent can damage its own application. Preserve Git checkpoints and use terminal access for repair.

Pi Durable supplies the local task journal. celld supplies a different layer: bucket-backed cells, ownership, and failover.
This first version omits celld, object storage, and a host-tool bridge. A future multi-node version can use Pi's Durable Object adapter.

## Operations

```sh
sudo systemctl status durable-agent
sudo journalctl -u durable-agent -n 100 --no-pager
sudo systemctl restart durable-agent
```

Use restart from chat after core changes. It checks syntax and tests before its result triggers process exit.
Extension entry files reload automatically. Invalid saves preserve the previous registry and show an error.
Imported helper or dependency changes still require restart. Tests do not gate automatic extension activation.
Browser edits trigger an automatic refresh after the next poll. Per-tab drafts survive through sessionStorage.
If browser storage fails, automatic refresh stops to protect the draft. Save the draft before a manual refresh.

If core edits prevent startup, open the VM terminal and inspect the journal plus git diff.
Restore only the broken files from a known-good commit. Then run npm run check and npm test.
Run sudo systemctl reset-failed durable-agent followed by sudo systemctl start durable-agent.
Never restore or delete the SQLite directory as part of code repair.

The VM source becomes authoritative after handoff. Do not overwrite it with the original development copy.
The service uses an unprivileged account and blocks privilege escalation. Tools still have that account's file and network access.

## Sources

- Pi Durable: https://github.com/earendil-works/pi/tree/main/packages/durable
- celld: https://celld.dev/docs/
- exe.dev LLM integration: https://exe.dev/docs/integrations-llm.md
