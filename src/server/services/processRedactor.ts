/** Redact before retaining output, including secrets split between stream chunks. */
export class ProcessRedactor {
  private pending = '';
  private prefixes = new Map<string, string[]>();
  constructor(values: string[]) {
    const patterns = [
      ...new Set(
        values.filter(Boolean).flatMap((value) => {
          const variants = [
            value,
            Buffer.from(value).toString('base64'),
            JSON.stringify(value).slice(1, -1),
          ];
          // URI encoding rejects unpaired UTF-16 surrogates; raw values still need redaction.
          try {
            variants.push(encodeURIComponent(value));
          } catch {
            /* No URI representation. */
          }
          return variants;
        }),
      ),
    ].sort((a, b) => b.length - a.length);
    for (const pattern of patterns) {
      const list = this.prefixes.get(pattern[0]) || [];
      list.push(pattern);
      this.prefixes.set(pattern[0], list);
    }
  }
  write(chunk: string, final = false) {
    if (!this.prefixes.size) return chunk;
    this.pending += chunk;
    let start = 0,
      index = 0;
    const output: string[] = [];
    while (index < this.pending.length) {
      const candidates = this.prefixes.get(this.pending[index]);
      if (!candidates) {
        index++;
        continue;
      }
      const remaining = this.pending.length - index;
      // Hold incomplete prefixes until the next chunk; never publish a secret in pieces.
      if (
        !final &&
        candidates.some(
          (value) => value.length > remaining && value.startsWith(this.pending.slice(index)),
        )
      )
        break;
      const match = candidates.find((value) => this.pending.startsWith(value, index));
      if (match) {
        output.push(this.pending.slice(start, index), '[redacted]');
        index += match.length;
        start = index;
      } else index++;
    }
    output.push(this.pending.slice(start, index));
    this.pending = this.pending.slice(index);
    return output.join('');
  }
  finish() {
    return this.write('', true);
  }
}
