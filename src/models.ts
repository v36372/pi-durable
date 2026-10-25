import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { Type, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import { Check } from 'typebox/value';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

export type ModelChoice = { provider: string; modelId: string; efforts: ModelThinkingLevel[] };

const Catalog = Type.Object({ data: Type.Array(Type.Object({ id: Type.String() })) });

export async function gatewayModels(baseUrl = 'https://llm.int.exe.xyz/v1', modelId = 'gpt-5.5') {
  const templates = openaiProvider().getModels();

  if (!templates.some(model => model.id === modelId)) throw new Error('Unknown OpenAI model: ' + modelId);
  let ids = new Set([modelId]);

  try {
    const response = await fetch(baseUrl.replace(/\/$/, '') + '/models', { signal: AbortSignal.timeout(10000) });

    if (!response.ok) throw new Error('HTTP ' + response.status);
    const catalog = await response.json();

    if (!Check(Catalog, catalog)) throw new Error('Invalid model catalog');
    ids = new Set(catalog.data.map(model => model.id));
    ids.add(modelId);
  } catch (cause) {
    // Keep existing conversations accessible if catalog discovery fails.
    console.error('Model catalog unavailable. Only the default model is selectable:', String(cause));
  }

  const models = createModels();
  models.setProvider(createProvider({
    id: 'exe', name: 'exe.dev', baseUrl,
    auth: { apiKey: { name: 'VM integration', resolve: async () => ({ auth: { apiKey: 'implicit' }, source: 'exe.dev LLM integration' }) } },
    models: templates.values().filter(model => ids.has(model.id)).map(model => ({ ...model, provider: 'exe', baseUrl })).toArray(),
    api: openAIResponsesApi(),
  }));

  return models;
}
