import type { CustomToolPresentation } from './customCapabilities';

const sensitiveParameter = /password|secret|token|api[_-]?key|authorization|credential/i;
const literal = (text: string) => text.replace(/([\\`*{}[\]()#+.!_>|~-])/g, '\\$1');
const label = (name: string) => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return literal(words.charAt(0).toUpperCase() + words.slice(1));
};

function readable(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value || '(empty)';
  if (typeof value !== 'object') return String(value);
  // Tool arguments are JSON; bound recursion for unusually deeply nested input.
  if (depth > 32)
    return literal(
      JSON.stringify(value, (key, item) => (sensitiveParameter.test(key) ? '[redacted]' : item)),
    );
  if (Array.isArray(value))
    return value.length
      ? value.map((item) => '- ' + readable(item, depth + 1).replace(/\n/g, '\n  ')).join('\n')
      : '(empty list)';
  const entries = Object.entries(value);
  return entries.length
    ? entries
        .map(([key, item]) => {
          const content = readable(sensitiveParameter.test(key) ? '[redacted]' : item, depth + 1);
          const separator = content.includes('\n') || /^[-*+>]\s/.test(content) ? '\n\n  ' : ' ';
          return `- **${label(key)}:**${separator}${content.replace(/\n/g, '\n  ')}`;
        })
        .join('\n')
    : '(empty object)';
}

/** Shared Markdown presentation; values always come from the saved invocation arguments. */
export function toolApprovalDetails(input: unknown, presentation?: CustomToolPresentation) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return readable(input);
  const fields: NonNullable<CustomToolPresentation['fields']> =
    presentation?.fields ?? Object.keys(input).map((parameter) => ({ parameter }));
  const parameters = input as Record<string, unknown>;
  const blocks = fields.flatMap((field) => {
    if (!Object.hasOwn(parameters, field.parameter)) return [];
    const value =
      field.presentation === 'secret' || sensitiveParameter.test(field.parameter)
        ? '[redacted]'
        : readable(parameters[field.parameter]);
    const heading = field.label ? literal(field.label) : label(field.parameter);
    const separator =
      field.presentation === 'long_text' ||
      value.includes('\n') ||
      /^(?:#{1,6}\s|[-*+>]\s|`{3}|~{3}|\d+[.)]\s)/.test(value)
        ? '\n\n'
        : ' ';
    return [`**${heading}:**${separator}${value}`];
  });
  return blocks.join('\n\n') || 'No parameters.';
}

export function toolApprovalPresentation(input: unknown, presentation?: CustomToolPresentation) {
  const details = toolApprovalDetails(input, presentation);
  return presentation?.title ? `${presentation.title}\n\n${details}` : details;
}
