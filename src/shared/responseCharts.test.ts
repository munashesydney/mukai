import { describe, expect, it } from 'vitest';
import { closedChartFence, inlineChartSchema, parseChartBlock } from './responseCharts';
const chart = {
  version: 1,
  type: 'line',
  title: 'Revenue',
  xKey: 'month',
  series: [{ key: 'revenue' }],
  data: [
    { month: 'Jan', revenue: -3 },
    { month: 'Feb', revenue: null },
    { month: 'Mar', revenue: 7 },
  ],
};
describe('Declarative response charts', () => {
  it('accepts both chart types, negative values, gaps and saved specifications', () => {
    expect(parseChartBlock(JSON.stringify(chart))).toEqual(chart);
    expect(inlineChartSchema.parse({ ...chart, type: 'bar' }).type).toBe('bar');
    expect(parseChartBlock('{"version":1,"source":"mukai://artifact/chart-json"}')).toEqual({
      version: 1,
      source: 'mukai://artifact/chart-json',
    });
  });
  it.each([
    { ...chart, type: 'javascript' },
    { ...chart, onClick: 'alert(1)' },
    { ...chart, data: [{ month: 'Jan', revenue: '7' }] },
    { ...chart, data: [{ revenue: 7 }] },
    { ...chart, data: [{ month: 'Jan', revenue: Infinity }] },
    { ...chart, data: [{ month: 'Jan', revenue: null }] },
    { ...chart, series: [{ key: 'revenue' }, { key: 'revenue' }] },
    { ...chart, data: Array.from({ length: 501 }, () => ({ month: 'Jan', revenue: 3 })) },
  ])('rejects invalid or unbounded specifications', (input) =>
    expect(inlineChartSchema.safeParse(input).success).toBe(false),
  );
  it('rejects oversized blocks and external data sources', () => {
    expect(() => parseChartBlock('x'.repeat(65537))).toThrow('too large');
    expect(() => parseChartBlock('{"version":1,"source":"https://example.com/private"}')).toThrow(
      'invalid format',
    );
  });
  it('waits for the matching closing fence', () => {
    expect(closedChartFence('```mukai-chart\n{}')).toBe(false);
    expect(closedChartFence('```mukai-chart\n{}\n```')).toBe(true);
    expect(closedChartFence('~~~~mukai-chart\n{}\n~~~')).toBe(false);
    expect(closedChartFence('~~~~mukai-chart\n{}\n~~~~')).toBe(true);
  });
});
