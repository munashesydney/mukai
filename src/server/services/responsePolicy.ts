import type { ModelMessage } from 'ai';

// The final, tool-free step is reserved for a human-readable report.
export const TOOL_STEP_LIMIT = 1000;
export const RUNTIME_TOOL_CALL_LIMIT = 2000;
export const FILE_TOOL_CALL_LIMIT = 2000;
export const RESPONSE_TIMEOUT_MS = 180000;
// Five retries after the initial request. The SDK handles backoff and cancellation.
export const PROVIDER_MAX_RETRIES = 5;
export const EMPTY_REPLY_RECOVERY_LIMIT = 2;

export const FINAL_REPLY_NOTICE =
  'Your last generation ended without a final reply. Use this conversation and any completed tool results or user answers already present to finish the original request with a concise final reply. Tools are disabled: do not repeat tool calls, questions, or completed actions. If work remains unfinished, explain what remains rather than claiming success. If another bot sent this request, your final text will automatically return to that bot; report the relevant results or user answer to it.';

export function emptyReplyRecoveryMessages(messages: ModelMessage[]): ModelMessage[] {
  // Start a fresh completion from the visible history. Replaying encrypted reasoning
  // can carry the previous decision to stop without speaking into the retry.
  // Keep the original checkpoint intact, including complete tool call/result pairs.
  const visible = messages.flatMap((message): ModelMessage[] => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return [message];
    const content = message.content.filter((part) => part.type !== 'reasoning');
    return content.length ? [{ ...message, content }] : [];
  });
  return [
    ...visible,
    {
      role: 'user',
      content:
        '[Mukai runtime continuation — not a new message from the human]\n' +
        'The previous tool step has ended. Any earlier instruction to call a tool and wait, or to avoid a normal reply instead of calling that tool, applied to that tool step. Now use the saved results above and write the final reply for this request. ' +
        'For an answered question, include the user’s actual answer in your report. Do not ask it again. ' +
        'Describe any failures or unfinished work accurately. You must return non-empty final text; do not end silently. ' +
        'If another bot sent this request, Mukai automatically delivers your final text back to it.',
    },
  ];
}

const RAW_TOOL_PROTOCOL = /<[｜|]{2}DSML[｜|]{2}\s+(?:calls|invoke|parameter)\b/;

export function containsRawToolProtocol(text: string) {
  return RAW_TOOL_PROTOCOL.test(text);
}

export function assistantContextText(text: string) {
  const start = text.search(RAW_TOOL_PROTOCOL);
  return start < 0
    ? text
    : text.slice(0, start).trimEnd() +
        '\n[The previous response printed a tool request as text. That request was not executed.]';
}
