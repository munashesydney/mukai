/** An expected refusal with a useful next action, rather than an execution fault. */
export class ToolFeedbackError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextAction?: { tool: string; input: Record<string, unknown> },
  ) {
    super(message);
  }
}

export function unsuccessfulToolResult(value: unknown) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (('ok' in value && value.ok === false) || ('rejected' in value && value.rejected === true)),
  );
}
