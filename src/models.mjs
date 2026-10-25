import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

export function gatewayModels(baseUrl = 'https://llm.int.exe.xyz/v1', modelId = 'gpt-5.5') {
  const template = openaiProvider().getModels().find(model => model.id === modelId);
  if (!template) throw new Error('Unknown OpenAI model: ' + modelId);
  const models = createModels();
  models.setProvider(createProvider({
    id: 'exe', name: 'exe.dev', baseUrl,
    auth: { apiKey: { name: 'VM integration', resolve: async () => ({ auth: { apiKey: 'implicit' }, source: 'exe.dev LLM integration' }) } },
    models: [{ ...template, provider: 'exe', baseUrl }],
    api: openAIResponsesApi(),
  }));
  return models;
}
