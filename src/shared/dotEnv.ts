/** Parse .env text locally for a review preview. Values never need to enter chat. */
export function parseDotEnv(text: string): { name: string; value: string }[] {
  const result = new Map<string, string>();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error('Invalid .env entry on line ' + (index + 1) + '.');
    const name = match[1];
    let value = match[2];
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
