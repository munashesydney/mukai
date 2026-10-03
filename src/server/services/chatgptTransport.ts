import { ApiError } from '../config';

const unsupported = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'previous_response_id',
];

/** Adapt only the ChatGPT plan route; other providers keep their normal contract. */
export function chatGPTRequest(body: Record<string, unknown>) {
  const adapted: Record<string, unknown> = { ...body, store: false, stream: true };
  for (const key of unsupported) delete (adapted as Record<string, unknown>)[key];
  if (!Array.isArray(adapted.input))
    throw new ApiError(400, 'ChatGPT requests require explicit conversation history.');
  adapted.input = adapted.input.map((item: Record<string, unknown>) => ({
    ...item,
    ...(item.role === 'system' ? { role: 'developer' } : {}),
    ...(item.type === 'function_call' && !item.namespace ? { namespace: 'mukai' } : {}),
  }));
  if (Array.isArray(adapted.tools)) {
    const functions = adapted.tools.filter((tool: Record<string, unknown>) =>
      ['function', 'custom'].includes(String(tool.type)),
    );
    const others = adapted.tools.filter(
      (tool: Record<string, unknown>) => !['function', 'custom'].includes(String(tool.type)),
    );
    if (others.some((tool: Record<string, unknown>) => tool.type !== 'namespace'))
      throw new ApiError(400, 'This tool is not supported by ChatGPT plan usage.');
    adapted.tools = [
      ...others,
      ...(functions.length
        ? [
            {
              type: 'namespace',
              name: 'mukai',
              description: 'Tools executed locally by Mukai.',
              tools: functions,
            },
          ]
        : []),
    ];
  }
  return adapted;
}

/** generateText still receives a normal Responses result, but the wire uses SSE. */
export async function collectChatGPTResponse(response: Response) {
  if (!response.body) throw new ApiError(502, 'ChatGPT returned no response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: Record<string, unknown> | undefined;
  const completedItems = new Map<number, Record<string, unknown>>();
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      receivedBytes += value?.byteLength || 0;
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      if (receivedBytes > 32 * 1024 * 1024)
        throw new ApiError(502, 'ChatGPT response exceeded the supported size.');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data) as {
          type: string;
          response?: Record<string, unknown>;
          error?: { code?: string };
          code?: string;
          output_index?: number;
          item?: Record<string, unknown>;
        };
        if (event.type === 'response.failed' || event.type === 'error') {
          const error = event.response?.error as { code?: string } | undefined;
          throw Object.assign(
            new ApiError(502, chatGPTError(error?.code || event.error?.code || event.code)),
            { code: error?.code || event.error?.code || event.code },
          );
        }
        // Plan usage can omit output from the terminal response. The completed
        // stream items contain the answer, reasoning, and tool calls in order.
        if (
          event.type === 'response.output_item.done' &&
          Number.isInteger(event.output_index) &&
          event.output_index! >= 0 &&
          event.item &&
          typeof event.item.id === 'string'
        )
          completedItems.set(event.output_index!, event.item);
        if (event.type === 'response.completed' || event.type === 'response.incomplete')
          result = event.response;
      }
      if (done) break;
    }
    if (!result)
      throw new ApiError(
        502,
        'ChatGPT’s response was interrupted before completion. Retry when connected.',
      );
    if (completedItems.size) {
      const streamed = [...completedItems.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, item]) => item);
      const terminal = Array.isArray(result.output)
        ? (result.output as Record<string, unknown>[])
        : [];
      const terminalIds = new Set(terminal.map((item) => item.id));
      if (streamed.some((item) => !terminalIds.has(item.id))) {
        const terminalById = new Map(terminal.map((item) => [item.id, item]));
        const streamedIds = new Set(streamed.map((item) => item.id));
        result.output = [
          ...streamed.map((item) => terminalById.get(item.id) || item),
          ...terminal.filter((item) => !streamedIds.has(item.id)),
        ];
      }
    }
    return new Response(JSON.stringify(result), {
      headers: {
        'Content-Type': 'application/json',
        ...(response.headers.get('x-request-id')
          ? { 'x-request-id': response.headers.get('x-request-id')! }
          : {}),
      },
    });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function chatGPTError(code?: string) {
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      return 'Your ChatGPT plan or Mukai app usage limit was reached. Review limits in ChatGPT Settings → Usage, then retry. Mukai has not switched billing providers.';
    case 'subscription_sharing_user_not_eligible':
      return 'ChatGPT plan usage is unavailable for this account or workspace. Check your plan and account permissions.';
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return 'ChatGPT usage is temporarily unavailable. Try again later.';
    case 'subscription_sharing_invalid_user':
      return 'ChatGPT could not validate this account. Reconnect it in Settings.';
    case 'subscription_sharing_unsupported_capability':
      return 'ChatGPT plan usage does not support this model, input, or tool. Choose another supported model or provider.';
    case 'subscription_sharing_route_not_supported':
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return 'ChatGPT plan permission did not authorize this request. Check the connection in Settings.';
    default:
      return 'ChatGPT could not complete the response. Retry or check the connection in Settings.';
  }
}
