import { describe, expect, it } from 'vitest';
import type { ChatMessage, ResponsePart } from './ai';
import { appendResponseText, formatWorkDuration, responsePresentation } from './responseParts';

const parts: ResponsePart[] = [
  { id: 'thought', type: 'reasoning', text: 'Review the file.' },
  { id: 'progress', type: 'text', text: 'I’ll read the file.' },
  { id: 'tool', type: 'tool', activityId: 'read' },
  { id: 'final', type: 'text', text: 'Here is the result.' },
];
const message: ChatMessage = {
  id: 'response',
  requestId: 'request',
  botId: 'scout',
  role: 'assistant',
  content: 'I’ll read the file.\n\nHere is the result.',
  status: 'complete',
  error: null,
  createdAt: '2026-10-02T00:00:00Z',
  attachments: [],
  parts,
};

describe('Response presentation', () => {
  it('keeps progress and reasoning in order and leaves the final answer outside the process', () => {
    expect(responsePresentation(message)).toEqual({
      process: parts.slice(0, 3),
      answer: 'Here is the result.',
    });
    expect(responsePresentation({ ...message, status: 'streaming' })).toEqual({
      process: parts,
      answer: '',
    });
  });
  it('does not discard multiple final text blocks or invent a process for plain answers', () => {
    const more: ResponsePart = { id: 'more', type: 'text', text: 'More detail.' };
    expect(responsePresentation({ ...message, parts: [...parts, more] }).answer).toBe(
      'Here is the result.\n\nMore detail.',
    );
    expect(responsePresentation({ ...message, parts: [parts[3], more] })).toEqual({
      process: [],
      answer: 'Here is the result.\n\nMore detail.',
    });
  });
  it.each(['failed', 'stopped', 'interrupted'] as const)(
    'preserves partial output inside a %s process',
    (status) => {
      expect(responsePresentation({ ...message, status })).toEqual({ process: parts, answer: '' });
    },
  );
  it('preserves old chats without guessing where their final response began', () => {
    expect(responsePresentation({ ...message, parts: [], reasoning: 'Old reasoning' })).toEqual({
      process: [{ id: 'legacy-reasoning', type: 'reasoning', text: 'Old reasoning' }],
      answer: message.content,
    });
  });
  it('keeps an updated earlier part in place after a later tool call arrives', () => {
    expect(
      appendResponseText(parts, 'progress', 'text', ' Now checking.').map((part) => part.id),
    ).toEqual(parts.map((part) => part.id));
    expect(appendResponseText(parts, 'progress', 'text', ' Now checking.')[1]).toMatchObject({
      text: 'I’ll read the file. Now checking.',
    });
    expect(parts[1]).toMatchObject({ text: 'I’ll read the file.' });
  });
  it('formats persisted elapsed time and handles unavailable or invalid timestamps', () => {
    expect(formatWorkDuration('2026-10-02T00:00:00Z', '2026-10-02T00:43:23Z')).toBe('43m 23s');
    expect(formatWorkDuration('2026-10-02T00:00:00Z', '2026-10-02T01:00:03Z')).toBe('1h 0m 3s');
    expect(formatWorkDuration(null, null)).toBeNull();
    expect(formatWorkDuration('invalid', 'invalid')).toBeNull();
    expect(formatWorkDuration('2026-10-02T00:00:01Z', '2026-10-02T00:00:00Z')).toBeNull();
  });
});
