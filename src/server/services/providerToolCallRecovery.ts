import type { ModelMessage } from 'ai';
import type { ApprovalStepCall } from '../repositories/chatJobRepository';

export type ProviderToolCallFailure = 'invalid_tool_call' | 'incomplete_tool_call';

/** Recognize structured engine errors, never infer a failure from arbitrary provider prose. */
export function providerToolCallFailure(error: unknown): ProviderToolCallFailure | undefined {
  const pending = [error];
  const seen = new Set<unknown>();
  let failure: ProviderToolCallFailure | undefined;
  while (pending.length && seen.size < 16) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const detail = current as {
      code?: unknown;
      statusCode?: number;
      cause?: unknown;
      lastError?: unknown;
      error?: unknown;
      data?: unknown;
      responseBody?: unknown;
    };
    // An actual authentication/quota rejection requires user action, not call repair.
    if ([401, 402, 403, 404, 429].includes(detail.statusCode ?? 0)) return;
    if (detail.code === 'invalid_tool_call' || detail.code === 'incomplete_tool_call')
      failure = detail.code;
    pending.push(detail.cause, detail.lastError, detail.error, detail.data);
    if (typeof detail.responseBody === 'string' && detail.responseBody.length <= 65536) {
      try {
        pending.push(JSON.parse(detail.responseBody));
      } catch {
        // Plain text and raw tool payloads are not trusted error classifications.
      }
    }
  }
  return failure;
}

export const PROVIDER_TOOL_CALL_RECOVERY_LIMIT = 2;

/** A failed SDK step can omit a late sibling result. Restore it from the execution journal. */
export function providerToolCallStep(
  response: ModelMessage[],
  delivered: ApprovalStepCall[],
): ModelMessage[] | undefined {
  if (delivered.some((call) => call.state !== 'resolved' || !call.output)) return;
  const content: Exclude<Extract<ModelMessage, { role: 'assistant' }>['content'], string> = [];
  const outputs = new Map<string, Extract<ModelMessage, { role: 'tool' }>['content'][number]>();
  const calls = new Set<string>();
  for (const message of response) {
    if (message.role === 'tool') {
      for (const part of message.content)
        if (part.type === 'tool-result') outputs.set(part.toolCallId, part);
    } else if (message.role === 'assistant') {
      if (typeof message.content === 'string')
        content.push({ type: 'text', text: message.content });
      else
        for (const part of message.content) {
          // Failed reasoning/signatures are not needed to correct a function call.
          if (part.type === 'reasoning' || part.type === 'reasoning-file') continue;
          if (part.type === 'tool-call') {
            if (calls.has(part.toolCallId)) continue;
            calls.add(part.toolCallId);
          }
          content.push(part);
        }
    }
  }
  for (const call of delivered) {
    if (!calls.has(call.toolCallId)) {
      content.push({
        type: 'tool-call',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      });
      calls.add(call.toolCallId);
    }
    outputs.set(call.toolCallId, {
      type: 'tool-result',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: call.output!,
    });
  }
  // The step has been cancelled and all started executions settled before this
  // function runs. A call absent from the journal never entered Mukai's executor.
  for (const part of content) {
    if (part.type === 'tool-call' && !outputs.has(part.toolCallId) && !part.providerExecuted)
      outputs.set(part.toolCallId, {
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: {
          type: 'error-text',
          value:
            'This call was not executed: the provider stream failed before Mukai dispatched it. If still needed, issue a fresh corrected call.',
        },
      });
  }
  if ([...calls].some((id) => !outputs.has(id)) || [...outputs.keys()].some((id) => !calls.has(id)))
    return;
  const messages: ModelMessage[] = [];
  if (content.length) messages.push({ role: 'assistant', content });
  if (outputs.size) messages.push({ role: 'tool', content: [...outputs.values()] });
  return messages;
}

export function providerToolCallFeedback(failure: ProviderToolCallFailure) {
  return (
    '[Mukai runtime tool-call recovery — not a new message from the human]\n' +
    (failure === 'incomplete_tool_call'
      ? 'The provider reported an incomplete/truncated function call (incomplete_tool_call). '
      : 'The provider could not parse a malformed function call (invalid_tool_call). ') +
    'The rejected call was not executed by Mukai. Any other calls delivered during that generation have their results recorded above; earlier completed operations and user answers are also preserved. ' +
    'Continue the original task from those results. Do not repeat completed calls or claim the rejected call succeeded. ' +
    'If the action is still needed, generate a corrected, complete structured tool call using an available tool and its declared argument schema. ' +
    'For operations whose results report failure or uncertainty, inspect the affected state before repeating an action. ' +
    'This is tool-call formatting feedback, not evidence of invalid credentials, a connection outage, or insufficient balance.'
  );
}
