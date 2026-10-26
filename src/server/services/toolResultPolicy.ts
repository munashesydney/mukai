import type { ModelMessage } from 'ai';

export const RESULT_TRUNCATED =
  '[The end was truncated because this tool result was too long for the configured context. Request a smaller range or a more specific result if needed.]';
export const IMAGE_OMITTED =
  '[Media content was omitted from this tool result because it exceeded the configured context or transport allowance.]';
export const ACTIVITY_TRUNCATED =
  '[Activity preview shortened; the model result is limited separately.]';
type ToolOutput = Extract<
  Extract<ModelMessage, { role: 'tool' }>['content'][number],
  { type: 'tool-result' }
>['output'];

export function utf8Prefix(text: string, bytes: number) {
  if (bytes <= 0) return '';
  // Slice before encoding: an unexpectedly huge string never creates a huge buffer.
  const buffer = Buffer.from(text.slice(0, bytes + 1), 'utf8');
  let end = Math.min(bytes, buffer.length);
  while (end < buffer.length && end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

export function limitResultText(text: string, bytes: number, notice = RESULT_TRUNCATED) {
  if (text.length <= bytes && Buffer.byteLength(text, 'utf8') <= bytes) return text;
  if (notice === RESULT_TRUNCATED && text.includes(IMAGE_OMITTED)) {
    const combined = RESULT_TRUNCATED + '\n' + IMAGE_OMITTED;
    notice = Buffer.byteLength(combined, 'utf8') + 32 <= bytes ? combined : IMAGE_OMITTED;
  }
  const marker = '\n\n' + notice;
  return utf8Prefix(text, Math.max(0, bytes - Buffer.byteLength(marker))) + marker;
}

// A bounded JSON preview avoids JSON.stringify allocating the entire result first.
// Limits also cover circular values, nesting and huge collections of tiny values.
export function resultPreview(value: unknown, bytes: number, notice = RESULT_TRUNCATED) {
  const marker = '\n\n' + notice;
  const allowance = Math.max(0, bytes);
  const chunks: string[] = [];
  const seen = new Set<object>();
  let remaining = allowance,
    clipped = false,
    nodes = 0;
  const write = (text: string) => {
    const prefix = utf8Prefix(text, remaining);
    chunks.push(prefix);
    remaining -= Buffer.byteLength(prefix);
    if (prefix !== text) clipped = true;
  };
  const visit = (item: unknown, depth: number) => {
    if (remaining <= 0 || ++nodes > 65536) {
      clipped = true;
      return;
    }
    if (item === null || typeof item !== 'object') {
      if (typeof item === 'string') {
        const prefix = item.slice(0, remaining);
        write(JSON.stringify(prefix));
        clipped ||= prefix !== item;
      } else
        write(
          typeof item === 'bigint'
            ? JSON.stringify(String(item))
            : (JSON.stringify(item) ?? 'null'),
        );
      return;
    }
    if (depth >= 24 || seen.has(item)) {
      write('"[Nested or circular value omitted]"');
      clipped = true;
      return;
    }
    seen.add(item);
    const array = Array.isArray(item);
    write(array ? '[' : '{');
    let first = true;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (clipped || remaining <= 0) {
        clipped = true;
        break;
      }
      if (!first) write(',');
      first = false;
      if (!array) {
        write(JSON.stringify(key.slice(0, remaining)));
        write(':');
      }
      try {
        visit((item as Record<string, unknown>)[key], depth + 1);
      } catch {
        write('"[Unreadable value omitted]"');
        clipped = true;
      }
    }
    write(array ? ']' : '}');
    seen.delete(item);
  };
  try {
    visit(value, 0);
  } catch {
    clipped = true;
  }
  const preview = chunks.join('');
  return clipped
    ? utf8Prefix(preview, Math.max(0, bytes - Buffer.byteLength(marker))) + marker
    : preview;
}

export function imageDeliveryState(
  output: unknown,
): 'included' | 'omitted' | 'unsupported' | undefined {
  const item = output as { type?: string; value?: unknown } | null;
  if (!item) return;
  const blocks = item.type === 'content' && Array.isArray(item.value) ? item.value : [];
  if (blocks.some((block) => block.type === 'file' && String(block.mediaType).startsWith('image/')))
    return 'included';
  const text =
    blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n') || (typeof item.value === 'string' ? item.value : '');
  if (text.includes(IMAGE_OMITTED) || text.includes('[Image omitted')) return 'omitted';
  if (text.includes('"imageDelivery":"unsupported"')) return 'unsupported';
  if (text.includes('"imageDelivery":"included"') || text.includes('"imageDelivery":"omitted"'))
    return 'omitted';
}

// Delivery metadata describes the bounded result, not the original capture.
// Reapply after group transport limits as well as individual result limits.
export function mediaDeliveryState(
  output: unknown,
): 'included' | 'omitted' | 'unsupported' | undefined {
  const item = output as { type?: string; value?: unknown } | null;
  if (!item) return;
  const blocks = item.type === 'content' && Array.isArray(item.value) ? item.value : [];
  if (
    blocks.some(
      (block) => block.type === 'file' && /^(audio|video)\//.test(String(block.mediaType)),
    )
  )
    return 'included';
  const text =
    blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n') || (typeof item.value === 'string' ? item.value : '');
  if (text.includes('"mediaDelivery":"unsupported"')) return 'unsupported';
  if (text.includes('"mediaDelivery":"included"') || text.includes('"mediaDelivery":"omitted"'))
    return 'omitted';
}
function syncImageDelivery(output: ToolOutput): ToolOutput {
  const state = imageDeliveryState(output),
    mediaState = mediaDeliveryState(output);
  if (!state && !mediaState) return output;
  const sync = (text: string) => {
    const [json, ...notices] = text.split('\n\n');
    try {
      const value = JSON.parse(json);
      if (value?.result && state && typeof value.result.imageIncluded === 'boolean') {
        value.result.imageIncluded = state === 'included';
        value.result.imageDelivery = state;
      }
      if (value?.result && mediaState && typeof value.result.mediaIncluded === 'boolean') {
        value.result.mediaIncluded = mediaState === 'included';
        value.result.mediaDelivery = mediaState;
      }
      return [JSON.stringify(value), ...notices].join('\n\n');
    } catch {
      /* Truncated metadata retains its explicit omission notice. */
    }
    return text;
  };
  if (output.type === 'content')
    return {
      ...output,
      value: output.value.map((block) =>
        block.type === 'text' ? { ...block, text: sync(block.text) } : block,
      ),
    };
  if (output.type === 'text') return { ...output, value: sync(output.value) };
  return output;
}

export function limitToolOutput(
  output: ToolOutput,
  tokens: number,
  estimate: (value: unknown) => number,
): ToolOutput {
  return syncImageDelivery(limitToolOutputValue(output, tokens, estimate));
}

function limitToolOutputValue(
  output: ToolOutput,
  tokens: number,
  estimate: (value: unknown) => number,
): ToolOutput {
  const bytes = Math.max(Buffer.byteLength(RESULT_TRUNCATED) + 32, Math.floor(tokens * 3) - 96);
  if (output.type === 'content') {
    const value: typeof output.value = [];
    let remaining = Math.max(128, tokens - 32);
    for (const [index, block] of output.value.entries()) {
      if (remaining < 128) {
        value.push({
          type: 'text',
          text: output.value
            .slice(index)
            .some(
              (part) =>
                part.type === 'file' || (part.type === 'text' && part.text.includes(IMAGE_OMITTED)),
            )
            ? IMAGE_OMITTED
            : RESULT_TRUNCATED,
        });
        break;
      }
      const size = estimate(block) + 4;
      const reserve = index < output.value.length - 1 ? estimate(RESULT_TRUNCATED) + 16 : 0;
      if (size <= remaining - reserve && binaryBytes(block) <= binaryAllowance(tokens)) {
        value.push(block);
        remaining -= size;
        continue;
      }
      if (block.type === 'text') {
        const text = limitResultText(
          block.text,
          Math.max(Buffer.byteLength(RESULT_TRUNCATED) + 32, (remaining - reserve) * 3 - 32),
        );
        value.push({ type: 'text', text });
        remaining -= estimate(text) + 8;
      } else {
        value.push({
          type: 'text',
          text: IMAGE_OMITTED,
        });
        remaining -= estimate(IMAGE_OMITTED) + 8;
      }
    }
    const limited = { ...output, value };
    // Several blocks can overflow their shared allowance even when each fits alone.
    if (estimate(limited) > tokens)
      return {
        type: 'text',
        value: limitResultText(
          value.map((block) => (block.type === 'text' ? block.text : IMAGE_OMITTED)).join('\n'),
          bytes,
        ),
      };
    return limited;
  }
  if (output.type === 'text' || output.type === 'error-text')
    return { ...output, value: limitResultText(output.value, bytes) };
  if (output.type === 'json' || output.type === 'error-json')
    return {
      type: output.type === 'error-json' ? 'error-text' : 'text',
      value: resultPreview(output.value, bytes),
    };
  return output;
}

function binaryAllowance(tokens: number) {
  // Pixel costs do not bound transport size: even a tiny PNG can contain huge
  // metadata. Keep previews/checkpoints bounded while allowing normal screenshots.
  return Math.max(2 * 1024 * 1024, Math.min(16 * 1024 * 1024, tokens * 64));
}
function binaryBytes(block: unknown) {
  if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'file') return 0;
  const data = (block as { data?: unknown }).data;
  const value = data && typeof data === 'object' && 'data' in data ? data.data : data;
  return typeof value === 'string'
    ? value.length
    : value instanceof Uint8Array
      ? value.byteLength
      : 0;
}

// Parallel tool results share one allowance; IDs and call/result structure survive.
export function limitToolGroups(
  messages: ModelMessage[],
  tokens: number,
  estimate: (value: unknown) => number,
): ModelMessage[] {
  const bounded = [...messages];
  for (let start = 0; start < messages.length; start++) {
    if (messages[start].role !== 'tool') continue;
    let end = start,
      count = 0;
    while (end < messages.length && messages[end].role === 'tool') {
      const message = messages[end];
      if (message.role === 'tool')
        count += message.content.filter((part) => part.type === 'tool-result').length;
      end++;
    }
    const structural = estimate(
      messages.slice(start, end).map((message) =>
        message.role === 'tool'
          ? {
              ...message,
              content: message.content.map((part) =>
                part.type === 'tool-result'
                  ? { ...part, output: { type: 'text', value: '' } }
                  : part,
              ),
            }
          : message,
      ),
    );
    const perResult = Math.max(128, Math.floor((tokens - structural) / Math.max(1, count)));
    for (let index = start; index < end; index++) {
      const message = messages[index];
      if (message.role === 'tool')
        bounded[index] = {
          ...message,
          content: message.content.map((part) =>
            part.type === 'tool-result'
              ? { ...part, output: limitToolOutput(part.output, perResult, estimate) }
              : part,
          ),
        };
    }
    start = end - 1;
  }
  // Retain the newest binary observations first. All tool messages share the
  // transport allowance, independent of parallelism and misleading image headers.
  let binaryRoom = binaryAllowance(tokens);
  for (let index = bounded.length - 1; index >= 0; index--) {
    const message = bounded[index];
    if (message.role !== 'tool') continue;
    bounded[index] = {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'tool-result' || part.output.type !== 'content') return part;
        return {
          ...part,
          output: syncImageDelivery({
            ...part.output,
            value: part.output.value.map((block) => {
              const size = binaryBytes(block);
              if (size > binaryRoom) return { type: 'text' as const, text: IMAGE_OMITTED };
              binaryRoom -= size;
              return block;
            }),
          }),
        };
      }),
    };
  }
  return bounded;
}
