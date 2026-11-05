import { describe, expect, it, vi } from 'vitest';
import { asSchema, jsonSchema, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { cachedToolSchema, estimateTokens, toolDefinitions, toolTokens } from './contextPolicy';

describe('tool context caching', () => {
  it('reuses Zod conversion for accounting and SDK requests, retaining validation', async () => {
    const input = z.object({ path: z.string().min(1), limit: z.number().default(20) });
    const cached = cachedToolSchema(input);
    const getter = vi.spyOn(cached, 'jsonSchema', 'get');
    const tools = { read: tool({ description: 'Read.', inputSchema: input }) };
    const expected = [
      { name: 'read', description: 'Read.', schema: await asSchema(input).jsonSchema },
    ];
    expect(cachedToolSchema(input)).toBe(cached);
    expect(await toolDefinitions(tools)).toEqual(expected);
    expect(await toolTokens(tools)).toBe(estimateTokens(expected));
    expect(await toolTokens({ read: tool({ ...tools.read }) })).toBe(estimateTokens(expected));
    // The SDK sees a Schema instead of wrapping/converting Zod again.
    expect(asSchema(cached)).toBe(cached);
    expect(await cached.validate?.({ path: 'notes.txt' })).toMatchObject({
      success: true,
      value: { path: 'notes.txt', limit: 20 },
    });
    expect(await cached.validate?.({ path: '' })).toMatchObject({ success: false });
    expect(getter).toHaveBeenCalled();
  });

  it('converts an unchanged Zod schema only once', async () => {
    const converter = vi.fn(() => 'Schema metadata read during conversion.');
    const input = z.object({ value: z.string() }).register(z.globalRegistry, {
      get description() {
        return converter();
      },
    });
    const tools = { test: tool({ inputSchema: input }) };
    await toolDefinitions(tools);
    const count = converter.mock.calls.length;
    expect(count).toBeGreaterThan(0);
    await toolTokens(tools);
    await toolTokens(tools);
    await asSchema(cachedToolSchema(input)).jsonSchema;
    expect(converter).toHaveBeenCalledTimes(count);
  });

  it('reflects schema replacement, description/name edits and added or removed tools', async () => {
    const tools: ToolSet = { read: tool({ description: 'Original.', inputSchema: z.object({}) }) };
    const original = await toolTokens(tools);
    tools.read.description = 'A much longer changed description of the tool.';
    expect(await toolTokens(tools)).toBeGreaterThan(original);
    tools.read.inputSchema = z.object({ requiredPath: z.string().describe('A required path.') });
    expect(JSON.stringify(await toolDefinitions(tools))).toContain('requiredPath');
    tools.renamed = tools.read;
    delete tools.read;
    expect((await toolDefinitions(tools))[0].name).toBe('renamed');
    tools.other = tool({ inputSchema: z.object({ other: z.boolean() }) });
    expect(await toolTokens(tools)).toBe(estimateTokens(await toolDefinitions(tools)));
    delete tools.other;
    expect(await toolTokens(tools)).toBe(estimateTokens(await toolDefinitions(tools)));
    expect(await toolTokens({})).toBe(0);
  });

  it('avoids recounting unchanged schema fields across recreated tool wrappers', async () => {
    const inputSchema = jsonSchema({
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          'field' + i,
          { type: 'string', description: 'Schema field description.' },
        ]),
      ),
    });
    const bytes = vi.spyOn(Buffer, 'byteLength');
    try {
      const tools = () => ({ example: tool({ description: 'Example.', inputSchema }) });
      const first = await toolTokens(tools());
      const initialCalls = bytes.mock.calls.length;
      bytes.mockClear();
      expect(await toolTokens(tools())).toBe(first);
      expect(bytes.mock.calls.length).toBeLessThan(initialCalls / 2);
    } finally {
      bytes.mockRestore();
    }
  });

  it('detects in-place JSON schema edits and leaves dynamic function schemas fresh', async () => {
    const raw = { type: 'object' as const, properties: { value: { type: 'string' as const } } };
    const tools: ToolSet = { custom: tool({ inputSchema: jsonSchema(raw) }) };
    const before = await toolTokens(tools);
    Object.assign(raw.properties.value, { description: 'New schema description.'.repeat(10) });
    expect(await toolTokens(tools)).toBeGreaterThan(before);
    expect(await toolTokens(tools)).toBe(estimateTokens(await toolDefinitions(tools)));
    let version = 0;
    tools.custom.inputSchema = () => jsonSchema({ type: 'object', description: String(++version) });
    expect((await toolDefinitions(tools))[0].schema.description).toBe('1');
    expect((await toolDefinitions(tools))[0].schema.description).toBe('2');
  });

  it('does not retain a failed dynamic conversion', async () => {
    let failed = true;
    const tools = {
      dynamic: tool({
        inputSchema: () => {
          if (failed) throw new Error('not ready');
          return jsonSchema({ type: 'object' });
        },
      }),
    };
    await expect(toolDefinitions(tools)).rejects.toThrow('not ready');
    failed = false;
    expect(await toolTokens(tools)).toBe(estimateTokens(await toolDefinitions(tools)));
  });
});
