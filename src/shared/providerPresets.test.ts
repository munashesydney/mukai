import { describe, expect, it } from 'vitest';
import { providerSchema } from '../server/http/schemas';
import { findProviderPreset, providerPresets, providerPresetInput } from './providerPresets';

describe('Provider presets', () => {
  it.each(['deepseek', 'glm', 'mimo', 'qwen', 'kimi'])(
    'creates a ready-to-configure %s connection',
    (id) => {
      const preset = providerPresets.find((preset) => preset.id === id)!;
      const input = providerPresetInput(preset);
      expect(providerSchema.safeParse(input).success).toBe(true);
      expect(new URL(input.baseUrl).protocol).toBe('https:');
      expect(input.models?.length).toBeGreaterThan(1);
      expect(input.models?.some((model) => model.id === input.defaultModel)).toBe(true);
      expect(
        input.models?.every(
          (model) => model.maxOutputTokens === 32768 && model.contextWindowTokens! >= 128000,
        ),
      ).toBe(true);
      expect(findProviderPreset(input)?.id).toBe(id);
      input.models![0].name = 'Edited';
      expect(preset.models[0].name).not.toBe('Edited');
    },
  );
  it('recognizes regional endpoints without matching unrelated custom hosts', () => {
    expect(
      findProviderPreset({
        kind: 'compatible',
        baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1/',
      })?.id,
    ).toBe('qwen');
    expect(
      findProviderPreset({ kind: 'compatible', baseUrl: 'https://unrelated.example/v1' }),
    ).toBeUndefined();
    expect(
      findProviderPreset({ kind: 'compatible', baseUrl: 'https://api.z.ai/api/coding/paas/v4' })
        ?.id,
    ).toBe('glm');
  });
});
