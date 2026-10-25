# Tool extensions

Create extensions/<name>.mjs. Export one Pi Durable extension as default.
The host loads these modules at startup and through reload_extensions or the UI button.
All conversations select installed extensions by default. This prototype has one root conversation.

defineTool validates arguments against its TypeBox schema. Tools can return text, structured results, and UI details.

```js
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

export default defineExtension({
  name: 'sample',
  tools: [defineTool({
    name: 'sample_echo',
    description: 'Return the supplied text.',
    parameters: Type.Object({ text: Type.String({ maxLength: 1000 }) }),
    replay: 'safe',
    execute: async ({ text }) => ({ output: [{ type: 'text', text }] }),
  })],
});
```

The example is documentation only. The initial registry contains no sample tool.

## Activation

1. Add a focused test and run npm run check plus npm test.
2. Call reload_extensions or press Reload extensions.
3. Confirm the name in the registry. Invoke the new tool through chat.

The loader validates the whole batch before it changes the registry.
Duplicate extension names and duplicate tool names fail. Core tools cannot receive extension overrides.
A failed reload leaves prior tools active. After a process restart, invalid extensions leave only the core tools active.
Remove a file and reload to remove its extension. Calls already in progress retain their prior implementation.

Entry modules reload by content hash. If an imported helper changes, call restart_agent.
Modules run as trusted Node code. A module's top-level effects cannot roll back after an import failure.
Avoid top-level servers, timers, and processes. If persistent resources need disposal, extend the loader before you add them.
Do not assume extension reload offers process isolation or a security sandbox.

## Future additions

MCP and codemode deliberately remain absent for the owner's first self-modification experiments.
Use the same extension contract when the owner requests either feature.
For nested tool calls, use api.executeTool rather than direct execute calls. Pi then retains validation and task semantics.
The installed Pi Durable package exposes a codemode adapter. Verify its version and sandbox dependency before use.
For MCP, validate remote schemas, define connection timeouts, and preserve unsafe replay defaults for unknown effects.
Store credentials outside the repository. Never display them in tool results.
