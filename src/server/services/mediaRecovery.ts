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
  function omit<T extends { type: string; mediaType?: string; filename?: string }>(
    part: T,
  ): T | { type: 'text'; text: string } {
    if (part.type !== 'file' || !/^(audio|video)\//i.test(part.mediaType || '')) return part;
    count++;
    const failure =
      reason === 'context'
        ? 'The current model input budget could not fit this media'
        : reason === 'size'
          ? 'The request/media exceeded the provider size limit'
          : 'The provider rejected the media input (format, codec, or modality)';
    return {
      type: 'text',
      text: `[Mukai media notice: ${failure}. Media type: ${part.mediaType}${part.filename ? `; untrusted filename: ${JSON.stringify(part.filename)}` : ''}. The bytes are omitted from this request. The original file is retained. This notice contains no transcript or description.]`,
    };
  }
  const result = messages.map((message): ModelMessage => {
    const before = count;
    if (message.role === 'user' && Array.isArray(message.content)) {
      const content = message.content.map(omit);
      return count === before ? message : { ...message, content };
    }
    if (message.role === 'tool') {
      const content = message.content.map((part) => {
        if (part.type !== 'tool-result' || part.output.type !== 'content') return part;
        const previous = count;
        const value = part.output.value.map(omit);
        if (count === previous) return part;
        return {
          ...part,
          output: {
            ...part.output,
            value: value.map((block) => {
              if (block.type !== 'text') return block;
              try {
                const data = JSON.parse(block.text);
                if (data?.result && typeof data.result.mediaIncluded === 'boolean') {
                  data.result.mediaIncluded = false;
                  data.result.mediaDelivery = 'omitted';
                  return { ...block, text: JSON.stringify(data) };
                }
              } catch {
                /* Notices and non-JSON text remain intact. */
              }
              return block;
            }),
          },
        };
      });
      return count === before ? message : { ...message, content };
    }
    return message;
  });
  return { messages: result, count };
}
