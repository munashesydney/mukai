import type { ChatMessage, ResponsePart } from './ai';

// Updating an existing part must never move it past later tool calls.
export function upsertResponsePart(parts: ResponsePart[], part: ResponsePart): ResponsePart[] {
  const index = parts.findIndex((item) => item.id === part.id);
  if (index < 0) return [...parts, part];
  return parts.map((item, position) => (position === index ? part : item));
}

export function appendResponseText(
  parts: ResponsePart[],
  id: string,
  type: 'text' | 'reasoning',
  text: string,
): ResponsePart[] {
  const previous = parts.find((part) => part.id === id);
  return upsertResponsePart(
    parts,
    type === 'reasoning'
      ? {
          id,
          type,
          text: (previous?.type === 'reasoning' ? previous.text : '') + text,
          state: 'streaming',
        }
      : {
          ...(previous?.type === 'text' ? previous : {}),
          id,
          type,
          text: (previous?.type === 'text' ? previous.text : '') + text,
        },
  );
}

export function responsePresentation(message: ChatMessage) {
  const parts = message.parts || [];
  if (!parts.length) {
    // Older chats did not retain chronology. Keep their answer intact.
    const process: ResponsePart[] = [];
    if (message.reasoning)
      process.push({ id: 'legacy-reasoning', type: 'reasoning', text: message.reasoning });
    for (const activity of message.activity || [])
      process.push({ id: `legacy-${activity.id}`, type: 'tool', activityId: activity.id });
    return { process, answer: message.content };
  }
  const hasProcess = parts.some((part) => part.type !== 'text');
  const joinText = (texts: ResponsePart[]) =>
    texts.reduce(
      (answer, part) =>
        part.type === 'text'
          ? answer + (answer && !part.continuationOf ? '\n\n' : '') + part.text
          : answer,
      '',
    );
  // A plain text response should still read like a normal message while streaming.
  if (!hasProcess && parts.every((part) => part.type === 'text'))
    return {
      process: [],
      answer: joinText(parts),
    };
  const last = parts.at(-1);
  if (
    (message.status === 'complete' || (last?.type === 'text' && last.final)) &&
    last?.type === 'text'
  ) {
    let finalStart = parts.length - 1;
    while (finalStart > 0 && parts[finalStart - 1].type === 'text') finalStart--;
    const answerIds = new Set(parts.slice(finalStart).map((part) => part.id));
    let first = parts[finalStart];
    while (first.type === 'text' && first.continuationOf) {
      const previousId = first.continuationOf;
      const previous = parts.find((part) => part.id === previousId && part.type === 'text');
      if (!previous || answerIds.has(previous.id)) break;
      answerIds.add(previous.id);
      first = previous;
    }
    return {
      process: parts.filter((part) => !answerIds.has(part.id)),
      answer: joinText(parts.filter((part) => answerIds.has(part.id))),
    };
  }
  return { process: parts, answer: '' };
}

export function formatWorkDuration(startedAt?: string | null, finishedAt?: string | null) {
  if (!startedAt || !finishedAt) return null;
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const seconds = Math.floor(elapsed / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours
    ? `${hours}h ${minutes}m ${seconds % 60}s`
    : minutes
      ? `${minutes}m ${seconds % 60}s`
      : `${seconds}s`;
}
