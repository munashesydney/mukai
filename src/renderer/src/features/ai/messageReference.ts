export type MessageReference = { label: string; text: string };

export function formatReference(text: string, reference?: MessageReference) {
  if (!reference) return text;
  const quote = reference.text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `Regarding ${reference.label}:\n${quote}\n\n${text}`;
}

/** Reads the quote format already stored in sent and queued messages. */
export function splitReference(text: string): { text: string; reference?: MessageReference } {
  if (!text.startsWith('Regarding ')) return { text };
  const start = text.indexOf(':\n> ', 'Regarding '.length);
  if (start < 0) return { text };
  const end = text.indexOf('\n\n', start + 2);
  if (end < 0) return { text };
  const lines = text.slice(start + 2, end).split('\n');
  if (!lines.every((line) => line.startsWith('> '))) return { text };
  return {
    reference: {
      label: text.slice('Regarding '.length, start),
      text: lines.map((line) => line.slice(2)).join('\n'),
    },
    text: text.slice(end + 2),
  };
}
