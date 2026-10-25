import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openAgent, context } from '../../src/agent.mjs';
const [workspace, phase] = process.argv.slice(2);
const keepAlive = setInterval(() => {}, 1000);
const faux = fauxProvider({ tokensPerSecond: 100000 });
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(phase === 'start' ? [
  fauxAssistantMessage(fauxToolCall('settled', {}), { stopReason:'toolUse' }),
  fauxAssistantMessage(fauxToolCall('interrupted', {}), { stopReason:'toolUse' }),
] : [fauxAssistantMessage('Recovered.')]);
const agent = await openAgent({ workspace, stateDir: join(workspace, 'state'), models, provider:'faux', modelId:'faux-1' });
const submission = await agent.root.submit({ type:'input', content:'Recover this run', requestId:'crash-test' }, context);
const result = await submission.wait(context);
const entries = await agent.root.entries({}, 100, undefined, context);
process.send({ result, entries: entries.items, root: agent.root.id });
await agent.close();
clearInterval(keepAlive);
process.disconnect();
