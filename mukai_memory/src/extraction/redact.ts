/** Best-effort credential redaction before storing or sending memory evidence. */
export function redactCredentials(text: string) {
  return text
    .replace(/\bBearer\s+[\w.~-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[a-z0-9_-]{12,}/gi, '[redacted]')
    .replace(
      /((?:api[_ -]?key|password|access[_ -]?token|secret)\s*(?::|=|\bis\b)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
}
