import { expect, it } from 'vitest';
import { providerPresets, providerPresetInput } from './providerPresets';
import {
  acceptedAttachments,
  attachmentInputError,
  modelInputCapabilities,
} from './modelCapabilities';

it.each([
  ['photo.PNG', '', 'image'],
  ['recording.wav', 'application/octet-stream', 'audio'],
  ['clip.MOV', '', 'video'],
  ['clipboard', 'image/png', 'image'],
  ['clipboard', 'audio/mpeg', 'audio'],
  ['clipboard', 'video/mp4', 'video'],
])('checks %s before accepting transferred files', (name, type, kind) => {
  const file = { name, type };
  const textOnly = { supportsImages: false, supportsAudio: false, supportsVideo: false };
  expect(attachmentInputError([file], textOnly)).toContain(`does not support ${kind} input`);
  expect(
    attachmentInputError([file], {
      supportsImages: true,
      supportsAudio: true,
      supportsVideo: true,
    }),
  ).toBe('');
  expect(attachmentInputError([{ name: 'notes.txt', type: 'text/plain' }], textOnly)).toBe('');
});
it.each([
  ['deepseek', [false, false]],
  ['glm', [false, true]],
  ['mimo', [true, true]],
  ['qwen', [false, true]],
  ['kimi', [false, true]],
] as const)(
  'uses researched %s capabilities without overwriting explicit model choices',
  (id, [audio, video]) => {
    const provider = providerPresetInput(providerPresets.find((preset) => preset.id === id)!);
    const model = provider.models![id === 'glm' ? 1 : 0];
    expect(
      modelInputCapabilities({ model: model.id, supportsImages: null }, provider),
    ).toMatchObject({ supportsAudio: audio, supportsVideo: video });
    provider.models = provider.models!.map((entry) => ({
      ...entry,
      supportsAudio: false,
      supportsVideo: false,
    }));
    expect(
      modelInputCapabilities({ model: model.id, supportsImages: null }, provider),
    ).toMatchObject({ supportsAudio: false, supportsVideo: false });
  },
);
it('recognizes existing preset rows without new flags and never leaks the previous default’s capabilities', () => {
  const provider = providerPresetInput(providerPresets.find((preset) => preset.id === 'mimo')!);
  provider.models = provider.models!.map((model) => {
    const copy = { ...model };
    delete copy.supportsAudio;
    delete copy.supportsVideo;
    return copy;
  });
  expect(
    modelInputCapabilities({ model: provider.defaultModel, supportsImages: null }, provider)
      .supportsAudio,
  ).toBe(true);
  provider.models.push({ ...provider.models[0], id: 'custom-text' });
  provider.defaultModel = 'custom-text';
  provider.supportsAudio = true;
  provider.supportsVideo = true;
  expect(modelInputCapabilities({ model: null, supportsImages: null }, provider)).toMatchObject({
    supportsAudio: false,
    supportsVideo: false,
  });
});
it('adapts the file picker and respects endpoint transport limits', () => {
  const provider = {
    ...providerPresetInput(providerPresets[0]),
    kind: 'google' as const,
    defaultModel: 'gemini-2.5-flash',
  };
  const capabilities = modelInputCapabilities({ model: null, supportsImages: null }, provider);
  expect(capabilities).toMatchObject({ supportsAudio: true, supportsVideo: true });
  expect(acceptedAttachments(capabilities)).toContain('.wav,.mp3');
  expect(acceptedAttachments({ ...capabilities, supportsAudio: false })).not.toContain('.wav');
  expect(
    modelInputCapabilities(
      { model: null, supportsImages: null },
      { ...provider, kind: 'anthropic', supportsAudio: true, supportsVideo: true },
    ),
  ).toMatchObject({ supportsAudio: false, supportsVideo: false });
});
