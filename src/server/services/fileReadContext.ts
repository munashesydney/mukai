import type { ModelMessage } from 'ai';
import { RESULT_TRUNCATED } from './toolResultPolicy';

type ToolResult = Extract<
  Extract<ModelMessage, { role: 'tool' }>['content'][number],
  {
    type: 'tool-result';
  }
>;
type ReadResult = Record<string, unknown> & {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
};
type ParsedRead = {
  result: ReadResult;
  envelope: Record<string, unknown>;
  nested: boolean;
  text: string;
};
const parsedReads = new WeakMap<object, { text: string; parsed: ParsedRead | undefined }>();

function readResult(part: ToolResult): ParsedRead | undefined {
  // Only harness-produced file reads qualify. execute_code output is deliberately opaque:
  // its internal tools must always return complete data to the script.
  if (part.toolName !== 'file_operations' || part.output.type !== 'text') return;
  const text = part.output.value;
  const cached = parsedReads.get(part.output);
  if (cached?.text === text) return cached.parsed;
  const parsed = parseRead(text);
  parsedReads.set(part.output, { text, parsed });
  return parsed;
}

function parseRead(text: string): ParsedRead | undefined {
  if (text.includes(RESULT_TRUNCATED)) return;
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(text);
  } catch {
    return;
  }
  if (!envelope || envelope.ok !== true) return;
  // Local reads are flat; the VM runtime wraps the same payload under result.
  const nested = !!envelope.result && typeof envelope.result === 'object';
  const result = (nested ? envelope.result : envelope) as ReadResult;
  if (
    result &&
    typeof result.path === 'string' &&
    typeof result.content === 'string' &&
    Number.isInteger(result.startLine) &&
    result.startLine > 0 &&
    Number.isInteger(result.endLine) &&
    result.endLine >= result.startLine &&
    Number.isInteger(result.totalLines) &&
    result.totalLines >= result.endLine &&
    typeof result.truncated === 'boolean'
  )
    return { result, envelope, nested, text };
}

/**
 * Derive the wire view from complete retained results on EVERY request. No reference
 * survives independently of its full source, including after trimming, compaction,
 * retries, or checkpoint reload. Reads still execute and recheck permissions/content.
 */
export function fileReadContext(messages: ModelMessage[]): ModelMessage[] {
  const seen = new Map<string, { content: string; toolCallId: string }>();
  const readCalls = new Set<string>();
  let changed = false;
  const projected = messages.map((message) => {
    if (message.role === 'assistant' && Array.isArray(message.content))
      for (const part of message.content)
        if (
          part.type === 'tool-call' &&
          part.toolName === 'file_operations' &&
          part.input &&
          typeof part.input === 'object' &&
          'action' in part.input &&
          part.input.action === 'read_file'
        )
          readCalls.add(part.toolCallId);
    if (message.role !== 'tool') return message;
    let replaced = false;
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result' || !readCalls.has(part.toolCallId)) return part;
      const parsed = readResult(part);
      if (!parsed) return part;
      const { result, envelope, nested, text } = parsed;
      const key = JSON.stringify([
        result.path,
        result.startLine,
        result.endLine,
        result.totalLines,
        result.truncated,
      ]);
      const previous = seen.get(key);
      if (previous?.content === result.content) {
        const replacement = {
          ...result,
          content: undefined,
          summary: 'This read returned the same text as the earlier retained file read.',
          unchanged: true,
          sourceToolCallId: previous.toolCallId,
        };
        const value = JSON.stringify(nested ? { ...envelope, result: replacement } : replacement);
        // Tiny files are cheaper to repeat than to replace with a reference.
        if (Buffer.byteLength(value) < Buffer.byteLength(text)) {
          changed = replaced = true;
          return { ...part, output: { type: 'text' as const, value } };
        }
      }
      seen.set(key, { content: result.content, toolCallId: part.toolCallId });
      return part;
    });
    return replaced ? { ...message, content } : message;
  });
  return changed ? projected : messages;
}
