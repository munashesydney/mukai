// The final, tool-free step is reserved for a human-readable report.
export const TOOL_STEP_LIMIT = 1000;
export const RUNTIME_TOOL_CALL_LIMIT = 2000;
export const FILE_TOOL_CALL_LIMIT = 2000;
export const RESPONSE_TIMEOUT_MS = 180000;

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
