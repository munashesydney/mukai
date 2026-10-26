import { expect, it, vi } from 'vitest';
import type { AttachmentRecord } from '../models/entities';
import { attachmentContext } from './attachmentContext';
const capable = { supportsImages: true, supportsAudio: true, supportsVideo: true };
const incapable = { supportsImages: false, supportsAudio: false, supportsVideo: false };
const file = (kind: AttachmentRecord['kind']): AttachmentRecord => ({
  kind,
  id: 'upload',
  botId: 'scout',
  conversationId: 'chat',
  messageId: 'user',
  name: `recording.${kind}`,
  mediaType: `${kind}/example`,
  size: 3,
  warning: null,
  storageName: 'private',
  extractedText: null,
});
it.each(['image', 'audio', 'video'] as const)(
  'omits historical %s bytes after a model switch and restores them when switching back',
  (kind) => {
    const bytes = vi.fn(() => Buffer.from('media'));
    expect(attachmentContext(file(kind), capable, bytes)).toContainEqual(
      expect.objectContaining({ type: 'file', data: 'bWVkaWE=' }),
    );
    bytes.mockClear();
    const skipped = attachmentContext(file(kind), incapable, bytes);
    expect(JSON.stringify(skipped)).toContain(`does not support ${kind} input`);
    expect(JSON.stringify(skipped)).not.toContain('bWVkaWE=');
    expect(bytes).not.toHaveBeenCalled();
    expect(skipped.every((part) => part.type === 'text')).toBe(true);
    expect(attachmentContext(file(kind), capable, bytes).some((part) => part.type === 'file')).toBe(
      true,
    );
  },
);
it('keeps missing media as an explicit notice and never invents a transcript', () => {
  const content = attachmentContext(file('audio'), capable, () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  expect(JSON.stringify(content)).toContain('contents are unavailable');
  expect(content.every((part) => part.type === 'text')).toBe(true);
});
