# Prototype verification

Verified on October 25, 2026.

## Automated checks

`npm run check` and all eight `npm test` checks pass on the development host and agent VM.
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

## Not tested

No VM reboot, disk-loss recovery, off-VM backup, or celld deployment test ran.
No hostile extension sandbox exists. The tests do not prove exactly-once external effects.
