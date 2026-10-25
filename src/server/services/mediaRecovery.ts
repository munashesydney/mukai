import type { ModelMessage } from 'ai';
import { isContextOverflow } from './providerService';

/** Classify admission failures only. Never reinterpret auth, quota or network failures as media. */
export function rejectedMedia(error: unknown): 'size' | 'format' | undefined {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 16) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const detail = current as {
      name?: string;
      functionality?: string;
      statusCode?: number;
      message?: string;
      responseBody?: string;
      cause?: unknown;
      lastError?: unknown;
    };
    if (isContextOverflow(current)) return;
    if (detail.statusCode === 413) return 'size';
    if (
      detail.statusCode &&
      detail.statusCode >= 400 &&
      ![400, 415, 422].includes(detail.statusCode)
    )
      return;
    if (
      (detail.name === 'AI_UnsupportedFunctionalityError' &&
        /audio|video/i.test(detail.functionality || '')) ||
      ([400, 415, 422].includes(detail.statusCode ?? 0) &&
        /audio|video|codec|mime|media.?type|file.?format/i.test(
          `${detail.message || ''} ${detail.responseBody || ''}`,
        ))
    )
      return 'format';
    pending.push(detail.cause, detail.lastError);
  }
}

/** Keep stored uploads and completed tool steps intact; omit bytes from this model request only. */
export function omitRejectedMedia(messages: ModelMessage[], reason: 'size' | 'format' | 'context') {
  let count = 0;
  const result = messages.map((message): ModelMessage => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message;
    const before = count;
    const replaced: ModelMessage = {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'file' || !/^(audio|video)\//i.test(part.mediaType)) return part;
        count++;
        return {
          type: 'text',
          text: `[Mukai media notice: ${reason === 'context' ? 'The current model context budget could not fit this' : 'The provider could not process this'} ${part.mediaType.startsWith('audio/') ? 'audio' : 'video'} attachment${part.filename ? ` (untrusted filename: ${JSON.stringify(part.filename)})` : ''}${reason === 'context' ? '' : reason === 'size' ? ' because of its request/media size limit' : ' because its input format, codec, or modality was rejected'}. Its bytes have been omitted from this request so you can still respond. The original attachment is retained. This notice provides no transcript or description; do not claim to have inspected the omitted media. Explain the limitation to the user and suggest ${reason === 'context' ? 'a shorter recording or a model with more input capacity' : reason === 'size' ? 'a smaller or shorter recording' : 'a supported format or a model that accepts this media'} when relevant. Use any earlier recorded observations accurately.]`,
        };
      }),
    };
    return count === before ? message : replaced;
  });
  return { messages: result, count };
}
