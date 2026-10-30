const exportHeader = '# Mukai environment export v1 (JSON-quoted values)';

/** Parse .env text locally for a review preview. Values never need to enter chat. */
export function parseDotEnv(text: string): { name: string; value: string }[] {
  const result = new Map<string, string>();
  const exported = text.startsWith(exportHeader + '\n') || text.startsWith(exportHeader + '\r\n');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error('Invalid .env entry on line ' + (index + 1) + '.');
    const name = match[1];
    let value = match[2];
    if (exported) {
      try {
        const decoded: unknown = JSON.parse(value);
        if (typeof decoded !== 'string') throw new Error();
        result.set(name, decoded);
        continue;
      } catch {
        throw new Error('Invalid exported value for ' + name + '.');
      }
    }
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      let end = value.indexOf(quote, 1);
      while (end < 0 && index + 1 < lines.length) {
        value += '\n' + lines[++index];
        end = value.indexOf(quote, 1);
      }
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1)))
        throw new Error('Invalid quoted value for ' + name + '.');
      value = value.slice(1, end);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    } else value = value.replace(/\s+#.*$/, '').trim();
    result.set(name, value);
  }
  if (!result.size) throw new Error('Enter at least one variable.');
  return [...result].map(([name, value]) => ({ name, value }));
}

/** Lossless, plaintext export; import recognizes the header before decoding escapes. */
export function serializeDotEnv(entries: { name: string; value: string }[]): string {
  for (const entry of entries)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name))
      throw new Error('Invalid environment variable name.');
  return (
    exportHeader +
    '\n' +
    entries.map(({ name, value }) => name + '=' + JSON.stringify(value)).join('\n') +
    '\n'
  );
}
