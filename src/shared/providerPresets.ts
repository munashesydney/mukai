import type { ProviderInput, ProviderKind, ProviderSettings, SavedProviderModel } from './ai';

export const defaultCompatibleContext = 128000;
export const defaultCompatibleOutput = 32768;

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  description: string;
  baseUrl: string;
  models: SavedProviderModel[];
  docsUrl?: string;
  note?: string;
  endpoints?: { name: string; url: string }[];
}

const model = (
  id: string,
  name: string,
  contextWindowTokens: number,
  supportsImages: boolean,
): SavedProviderModel => ({
  id,
  name,
  contextWindowTokens,
  maxOutputTokens: defaultCompatibleOutput,
  supportsImages,
});

// Official API catalogs checked October 13, 2026. Response caps are Mukai defaults,
// not claims about a model's maximum output capacity. See docs/provider-presets.md.
export const providerPresets: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    description: 'Connect with an OpenAI API key.',
    baseUrl: '',
    models: [],
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT subscription',
    kind: 'chatgpt',
    description: 'Sign in with your eligible ChatGPT plan.',
    baseUrl: '',
    models: [],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    description: 'Connect Claude with an Anthropic API key.',
    baseUrl: '',
    models: [],
  },
  {
    id: 'google',
    name: 'Google',
    kind: 'google',
    description: 'Connect Gemini with a Google API key.',
    baseUrl: '',
    models: [],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'compatible',
    description: 'DeepSeek Flash and Pro, ready to configure.',
    baseUrl: 'https://api.deepseek.com',
    docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing/',
    models: [
      model('deepseek-flash', 'DeepSeek Flash', 1000000, true),
      model('deepseek-v4-pro', 'DeepSeek V4 Pro', 1000000, false),
    ],
  },
  {
    id: 'glm',
    name: 'Z.ai / GLM',
    kind: 'compatible',
    description: 'GLM flagship and visual Flash models.',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    docsUrl: 'https://docs.z.ai/api-reference/introduction',
    note: 'Uses the standard API endpoint. Coding Plan requires an eligible plan key and does not include FlashX.',
    endpoints: [
      { name: 'Standard API', url: 'https://api.z.ai/api/paas/v4' },
      { name: 'Coding Plan', url: 'https://api.z.ai/api/coding/paas/v4' },
    ],
    models: [
      model('glm-5.3', 'GLM 5.3', 1000000, false),
      model('glm-5.3-flash', 'GLM 5.3 Flash', 1000000, true),
      model('glm-5.3-flashx', 'GLM 5.3 FlashX', 1000000, true),
    ],
  },
  {
    id: 'mimo',
    name: 'Xiaomi MiMo',
    kind: 'compatible',
    description: 'MiMo Pro and Flash with image support.',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    docsUrl: 'https://mimo.mi.com/models/en-US/mimo-v2.6-pro',
    note: 'Uses the pay-as-you-go API. Token Plan subscriptions use a separate key and endpoint.',
    models: [
      model('mimo-v2.6-pro', 'MiMo V2.6 Pro', 1000000, true),
      model('mimo-v2.6-flash', 'MiMo V2.6 Flash', 1000000, true),
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    kind: 'compatible',
    description: 'Qwen Max and Flash through Alibaba Cloud.',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    docsUrl:
      'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope',
    note: 'The endpoint and API key must use the same region. Workspace-specific domains can also be entered below.',
    endpoints: [
      { name: 'Singapore', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
      { name: 'US (Virginia)', url: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' },
      { name: 'China (Beijing)', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    ],
    models: [
      model('qwen3.8-max', 'Qwen 3.8 Max', 1000000, true),
      model('qwen3.8-flash', 'Qwen 3.8 Flash', 1000000, true),
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    kind: 'compatible',
    description: 'Kimi K3 and dedicated coding models.',
    baseUrl: 'https://api.moonshot.ai/v1',
    docsUrl: 'https://platform.kimi.ai/docs/api/models-overview',
    models: [
      model('kimi-k3', 'Kimi K3', 1000000, true),
      model('kimi-k2.7-code', 'Kimi K2.7 Code', 256000, true),
      model('kimi-k2.7-code-highspeed', 'Kimi K2.7 Code Highspeed', 256000, true),
      model('kimi-k2.6', 'Kimi K2.6', 256000, true),
    ],
  },
  {
    id: 'compatible',
    name: 'OpenAI-compatible / local',
    kind: 'compatible',
    description: 'Use your own endpoint and model IDs.',
    baseUrl: '',
    models: [],
  },
];

export function findProviderPreset(provider: Pick<ProviderSettings, 'kind' | 'baseUrl'>) {
  return providerPresets.find(
    (preset) =>
      preset.kind === provider.kind &&
      (provider.kind !== 'compatible' ||
        [preset.baseUrl, ...(preset.endpoints?.map((endpoint) => endpoint.url) ?? [])]
          .filter(Boolean)
          .includes(provider.baseUrl.replace(/\/+$/, ''))),
  );
}

export function providerPresetInput(preset: ProviderPreset, isDefault = false): ProviderInput {
  const selected = preset.models[0];
  return {
    name: preset.name,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    models: preset.models.map((model) => ({ ...model })),
    defaultModel: selected?.id ?? '',
    contextWindowTokens:
      selected?.contextWindowTokens ??
      (preset.kind === 'compatible' ? defaultCompatibleContext : null),
    maxOutputTokens:
      selected?.maxOutputTokens ?? (preset.kind === 'compatible' ? defaultCompatibleOutput : 8192),
    supportsImages: selected?.supportsImages ?? preset.kind !== 'compatible',
    isDefault,
    apiKey: '',
  };
}
