import type { Attachment, Bot, ProviderSettings } from './ai';
import { findProviderPreset } from './providerPresets';

export type InputCapabilities = {
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
};

export function modelInputCapabilities(
  bot: Pick<Bot, 'model' | 'supportsImages'>,
  provider?: Pick<
    ProviderSettings,
    | 'kind'
    | 'baseUrl'
    | 'models'
    | 'defaultModel'
    | 'supportsImages'
    | 'supportsAudio'
    | 'supportsVideo'
  >,
): InputCapabilities {
  const id = bot.model || provider?.defaultModel || '';
  const saved = provider?.models?.find((model) => model.id === id);
  const known = provider && findProviderPreset(provider)?.models.find((model) => model.id === id);
  const gemini =
    provider?.kind === 'google' &&
    /^gemini-(?:2\.[05]|3(?:\.\d+)?)-(?:pro|flash)(?:-|$)/i.test(id) &&
    !/image|tts|live|native-audio/i.test(id);
  const sameDefault = id === provider?.defaultModel;
  return {
    supportsImages:
      saved?.supportsImages ?? bot.supportsImages ?? provider?.supportsImages ?? false,
    supportsAudio:
      ['google', 'compatible', 'openai'].includes(provider?.kind || '') &&
      (saved?.supportsAudio ??
        known?.supportsAudio ??
        (gemini || (!saved && sameDefault && !!provider?.supportsAudio))),
    supportsVideo:
      ['google', 'compatible'].includes(provider?.kind || '') &&
      (saved?.supportsVideo ??
        known?.supportsVideo ??
        (gemini || (!saved && sameDefault && !!provider?.supportsVideo))),
  };
}

export function supportsAttachment(kind: Attachment['kind'], capabilities: InputCapabilities) {
  return (
    kind === 'text' ||
    capabilities[
      kind === 'image' ? 'supportsImages' : kind === 'audio' ? 'supportsAudio' : 'supportsVideo'
    ]
  );
}

/** File pickers are advisory; drops and clipboard files need the same capability check. */
export function attachmentInputError(
  files: Pick<File, 'name' | 'type'>[],
  capabilities: InputCapabilities,
) {
  const blocked = new Set<string>();
  for (const file of files) {
    const kind = /\.(png|jpe?g|webp)$/i.test(file.name)
      ? 'image'
      : /\.(wav|mp3)$/i.test(file.name)
        ? 'audio'
        : /\.(mp4|mov)$/i.test(file.name)
          ? 'video'
          : file.type.startsWith('image/')
            ? 'image'
            : file.type.startsWith('audio/')
              ? 'audio'
              : file.type.startsWith('video/')
                ? 'video'
                : 'text';
    if (!supportsAttachment(kind, capabilities)) blocked.add(kind);
  }
  return blocked.size
    ? `This model does not support ${[...blocked].join(', ')} input. Choose a model that supports it before attaching.`
    : '';
}

export function inputCapabilityLabel(capabilities: InputCapabilities) {
  const media = [
    capabilities.supportsImages && 'images',
    capabilities.supportsAudio && 'audio',
    capabilities.supportsVideo && 'video',
  ].filter(Boolean);
  return media.length ? `Text, ${media.join(', ')}` : 'Text only';
}

export function acceptedAttachments(capabilities: InputCapabilities) {
  return [
    '.pdf,.docx,.txt,.md,.csv,.json,.html,.xml,.ts,.js,.py,.css,.yaml,.yml,.log',
    capabilities.supportsImages && '.png,.jpg,.jpeg,.webp',
    capabilities.supportsAudio && '.wav,.mp3',
    capabilities.supportsVideo && '.mp4,.mov',
  ]
    .filter(Boolean)
    .join(',');
}
