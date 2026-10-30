import { ApiError } from '../config';

type RedactionBudget = { remaining: number };
function spend(budget: RedactionBudget, size: number) {
  budget.remaining -= size;
  if (budget.remaining < 0)
    throw new ApiError(400, 'Response is too complex to redact safely. Return smaller chunks.');
}

/** Matches original input once: inserted placeholders are never redacted again. */
export class CapabilityRedactor {
  private pattern?: RegExp;
  private structuredSecrets = new Set<string>();
  constructor(private secrets: Set<string>) {
    const variants = new Set<string>();
    for (const secret of secrets) {
      if (!secret) continue;
      variants.add(secret);
      try {
        variants.add(encodeURIComponent(secret));
      } catch {
        /* Literal matching still handles malformed Unicode. */
      }
      if (/^\s*[[{]/.test(secret)) {
        try {
          this.structuredSecrets.add(JSON.stringify(JSON.parse(secret)));
        } catch {
          /* Plain secret. */
        }
      }
      variants.add(Buffer.from(secret).toString('base64'));
    }
    if (variants.size)
      this.pattern = new RegExp(
        [...variants]
          .sort((a, b) => b.length - a.length)
          .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|'),
        'g',
      );
  }
  text(value: string) {
    let count = 0;
    const result = this.pattern
      ? value
          .split('[redacted]')
          .map((part) =>
            part.replace(this.pattern!, () => {
              count++;
              return '[redacted]';
            }),
          )
          .join('[redacted]')
      : value;
    return { value: result, count };
  }
  primitive(value: unknown) {
    return value !== undefined && this.secrets.has(String(value))
      ? { value: '[redacted]', count: 1 }
      : { value, count: 0 };
  }
  value(
    value: unknown,
    budget: RedactionBudget = { remaining: 4 * 1024 * 1024 },
  ): { value: unknown; count: number } {
    if (typeof value === 'string')
      return /^\s*[[{]/.test(value)
        ? (this.json(value, budget) ?? this.text(value))
        : this.text(value);
    if (value && typeof value === 'object' && this.structuredSecrets.size) {
      const canonical = JSON.stringify(value);
      spend(budget, canonical.length);
      if (this.structuredSecrets.has(canonical)) return { value: '[redacted]', count: 1 };
    }
    if (Array.isArray(value)) {
      let count = 0;
      const result = value.map((item) => {
        const next = this.value(item, budget);
        count += next.count;
        return next.value;
      });
      return { value: result, count };
    }
    if (value && typeof value === 'object') {
      let count = 0;
      const entries = Object.entries(value).map(([key, item]) => {
        const name = this.text(key),
          next = this.value(item, budget);
        count += name.count + next.count;
        return [name.value, next.value];
      });
      return { value: Object.fromEntries(entries), count };
    }
    return this.primitive(value);
  }
  /** Rewrite JSON tokens, preserving untouched bytes and large numeric identifiers. */
  json(
    value: string,
    budget: RedactionBudget = { remaining: 4 * 1024 * 1024 },
  ): { value: string; count: number } | undefined {
    spend(budget, value.length);
    try {
      JSON.parse(value);
    } catch {
      return undefined;
    }
    const replacements: { start: number; end: number; value: string; count: number }[] = [];
    const containers: number[] = [];
    const tokens =
      /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]]/g;
    for (const match of value.matchAll(tokens)) {
      const token = match[0],
        start = match.index!;
      if (token === '{' || token === '[') {
        containers.push(start);
        continue;
      }
      if (token === '}' || token === ']') {
        const begin = containers.pop()!;
        if (this.structuredSecrets.size) {
          spend(budget, start + 1 - begin);
          if (this.structuredSecrets.has(JSON.stringify(JSON.parse(value.slice(begin, start + 1)))))
            replacements.push({ start: begin, end: start + 1, value: '"[redacted]"', count: 1 });
        }
        continue;
      }
      if (this.secrets.has(token)) {
        replacements.push({ start, end: start + token.length, value: '"[redacted]"', count: 1 });
        continue;
      }
      if (token.startsWith('"')) {
        const next = this.value(JSON.parse(token) as string, budget);
        if (next.count)
          replacements.push({
            start,
            end: start + token.length,
            value: JSON.stringify(next.value),
            count: next.count,
          });
      } else if (this.secrets.has(String(JSON.parse(token))))
        replacements.push({ start, end: start + token.length, value: '"[redacted]"', count: 1 });
    }
    let end = 0,
      count = 0;
    const chunks: string[] = [];
    // A whole secret JSON value supersedes replacements within that value.
    for (const replacement of replacements.sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (replacement.start < end) continue;
      chunks.push(value.slice(end, replacement.start), replacement.value);
      end = replacement.end;
      count += replacement.count;
    }
    chunks.push(value.slice(end));
    return { value: chunks.join(''), count };
  }
}
