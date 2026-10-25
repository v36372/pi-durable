# Prototype verification

Verified on October 25, 2026.

## Initial prototype checks

At initial deployment, `npm run check` and all eight `npm test` checks passed on both hosts.
The tests cover input validation, extension replacement, failed batch preservation, code tools, request deduplication, and restart coordination.
Two tests send SIGKILL during a tool call. Settled effects occur once. Safe tools resume. Unsafe tools return an interruption error.

## Live agent

The agent uses gpt-5.5 through the VM’s llm integration without provider credentials on disk.
It read its own instructions and used bash to verify its workspace and Node version.
It created a temporary prototype_probe extension and a focused test, then passed its checks.
It loaded that extension and invoked the new tool. The result was `probe:durable`.
It removed only those temporary files, reloaded, and invoked restart_agent once.
Systemd replaced the process. The same conversation resumed and confirmed the result.
The final registry contains six core tools. No MCP, codemode, or sample extension remains.

## Browser and access

Chromium submitted a message, received `UI-SMOKE-OK`, refreshed, and confirmed the response remained.
The extension reload button worked. Desktop and 390-pixel mobile layouts had no page errors or horizontal overflow.
The browser test used an authorized VM command tunnel for the real assets and API. It did not use an owner browser session.
A separate anonymous HTTPS request received the exe.dev login redirect. The VM share configuration reports private.
Cross-origin mutations and forged Host headers returned 403. A second startup failed the process lock.
Both systemd services report active and enabled.

## Automatic reload update

All 15 tests pass on both hosts after the automatic reload change.
Tests cover file saves, atomic replacements, failed reload recovery, deletion, watcher shutdown, and next-request tool availability.
Client tests cover draft retention, request ID retention, delayed refresh during submission, and browser storage failures.

Chromium confirmed automatic extension creation, error display, recovery, and removal against the live VM.
The agent invoked the new tool without a reload command. The test then removed its temporary extension.
A CSS edit triggered a browser refresh and preserved the unsent draft. The process and conversation IDs did not change.
The reload button is absent. POST /api/reload returns 404. The registry contains read, write, edit, bash, and restart.
No page errors or horizontal overflow appeared at desktop or mobile widths.
The browser test used the authorized VM command tunnel, including cross-site document request headers.

## Not tested

No VM reboot, disk-loss recovery, off-VM backup, or celld deployment test ran.
No hostile extension sandbox exists. The tests do not prove exactly-once external effects.
