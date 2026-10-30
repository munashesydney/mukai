import { describe, expect, it, vi } from 'vitest';
import type { Bot } from '../../../shared/ai';
import type { EnvironmentVariable } from '../../../shared/customCapabilities';
import { toolCatalog } from '../registry';
import { workspaceToolIds } from '../../../shared/toolAssignments';
import {
  ENV_VAR_PAGE_MAX,
  listEnvironmentVariables,
  systemTools,
  type EnvironmentVariablePage,
} from './execute';

const options = { toolCallId: 'system-call', messages: [], context: {} };
const variable = (name: string, configured: boolean, usedBy: string[]): EnvironmentVariable => ({
  name,
  configured,
  usedBy,
});

describe('system tool family', () => {
  it('registers a normal bot-assignable family with one read-only action', () => {
    expect(workspaceToolIds).toContain('system');
    const tool = toolCatalog().find((entry) => entry.id === 'system');
    expect(tool?.name).toBe('System');
    expect(tool?.actions).toContain('list_env_vars');
    expect(tool?.actions).toHaveLength(1);
  });

  it('pages by name without a query and stops paging on the last slice', () => {
    const variables = ['ALPHA', 'BETA', 'GAMMA', 'DELTA'].map((name) => variable(name, true, []));
    const first = listEnvironmentVariables(variables, { limit: 2 });
    expect(first).toMatchObject({ total: 4, matched: 4, limit: 2, offset: 0, nextOffset: 2 });
    expect(first.variables.map((item) => item.name)).toEqual(['ALPHA', 'BETA']);
    const last = listEnvironmentVariables(variables, { limit: 2, offset: 2 });
    expect(last.variables.map((item) => item.name)).toEqual(['GAMMA', 'DELTA']);
    expect(last.nextOffset).toBeNull();
  });

  it('defaults to 25 per page', () => {
    const variables = Array.from({ length: 30 }, (_, index) => variable(`VAR_${index}`, true, []));
    const page = listEnvironmentVariables(variables, {});
    expect(page.limit).toBe(25);
    expect(page.variables).toHaveLength(25);
    expect(page.nextOffset).toBe(25);
  });

  it('reports the matched count separately from the total when searching', () => {
    const variables = [
      variable('OPENAI_API_KEY', true, ['gpt-caller']),
      variable('STRIPE_KEY', false, ['billing-route']),
      variable('DATABASE_URL', true, []),
    ];
    const page = listEnvironmentVariables(variables, { query: 'key' });
    expect(page.total).toBe(3);
    expect(page.matched).toBe(2);
    expect(page.variables.map((item) => item.name)).toEqual(['OPENAI_API_KEY', 'STRIPE_KEY']);
    expect(page.nextOffset).toBeNull();
  });

  it('matches a capability name in usedBy, case-insensitively, and trims the query', () => {
    const variables = [
      variable('OPENAI_API_KEY', true, ['gpt-caller']),
      variable('STRIPE_KEY', false, ['billing-route']),
    ];
    expect(
      listEnvironmentVariables(variables, { query: '  Billing ' }).variables.map((i) => i.name),
    ).toEqual(['STRIPE_KEY']);
    expect(listEnvironmentVariables(variables, { query: 'GPT' }).matched).toBe(1);
    expect(listEnvironmentVariables(variables, { query: 'nothing' })).toMatchObject({
      matched: 0,
      variables: [],
      nextOffset: null,
    });
  });

  it('handles an empty workspace and offsets past the end', () => {
    expect(listEnvironmentVariables([], {})).toMatchObject<Partial<EnvironmentVariablePage>>({
      total: 0,
      matched: 0,
      variables: [],
      nextOffset: null,
    });
    const variables = [variable('ALPHA', true, [])];
    expect(listEnvironmentVariables(variables, { offset: 10 })).toMatchObject({
      total: 1,
      matched: 1,
      variables: [],
      nextOffset: null,
    });
  });

  it('clamps limit and offset instead of trusting model input', () => {
    const variables = Array.from({ length: 3 }, (_, index) => variable(`VAR_${index}`, true, []));
    expect(listEnvironmentVariables(variables, { limit: 5000 }).limit).toBe(ENV_VAR_PAGE_MAX);
    expect(listEnvironmentVariables(variables, { limit: 0 }).limit).toBe(1);
    expect(listEnvironmentVariables(variables, { offset: -5 })).toMatchObject({
      offset: 0,
      variables: [{ name: 'VAR_0' }, { name: 'VAR_1' }, { name: 'VAR_2' }],
    });
  });

  it('reads names and status through the tool, never values', async () => {
    const onActivity = vi.fn();
    const list = vi.fn(() => [
      variable('OPENAI_API_KEY', true, ['gpt-caller']),
      variable('STRIPE_KEY', false, ['billing-route']),
    ]);
    const tools = systemTools({
      bot: { id: 'scout', workspaceId: 'default' } as Bot,
      conversationId: 'conversation',
      environment: { list } as never,
      signal: new AbortController().signal,
      onActivity,
    });
    const output = await tools.system.execute!(
      { action: 'list_env_vars', query: 'key', limit: 1 },
      options,
    );
    expect(list).toHaveBeenCalledWith('default');
    expect(output).toMatchObject({
      ok: true,
      result: {
        total: 2,
        matched: 2,
        limit: 1,
        offset: 0,
        nextOffset: 1,
        variables: [{ name: 'OPENAI_API_KEY', configured: true, usedBy: ['gpt-caller'] }],
      },
    });
    expect(JSON.stringify(output)).not.toMatch(/value/i);
    expect(onActivity.mock.calls[0]?.[0]).toMatchObject({
      tool: 'system',
      action: 'list_env_vars',
    });
    expect(onActivity.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'complete' });
  });
});
