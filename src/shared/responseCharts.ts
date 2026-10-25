import { z } from 'zod';
import { parseResponseReference } from './responseReferences';

const key = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine((value) => !['constructor', 'prototype', '__proto__'].includes(value));
const value = z.union([z.string().max(160), z.number().finite().min(-1e12).max(1e12), z.null()]);
export const inlineChartSchema = z
  .object({
    version: z.literal(1),
    type: z.enum(['bar', 'line']),
    title: z.string().min(1).max(160),
    xKey: key,
    series: z
      .array(z.object({ key, label: z.string().min(1).max(100).optional() }).strict())
      .min(1)
      .max(4),
    data: z
      .array(z.record(key, value).refine((row) => Object.keys(row).length <= 20))
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((chart, context) => {
    if (new Set(chart.series.map((series) => series.key)).size !== chart.series.length)
      context.addIssue({ code: 'custom', message: 'Series keys must be unique.' });
    if (chart.series.some((series) => series.key === chart.xKey))
      context.addIssue({ code: 'custom', message: 'Series keys must differ from xKey.' });
    if (
      chart.data.some(
        (row) =>
          row[chart.xKey] == null ||
          chart.series.some(
            (series) => row[series.key] !== null && typeof row[series.key] !== 'number',
          ),
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Each row needs an x value and a number or null for every series.',
      });
    if (
      !chart.data.some((row) => chart.series.some((series) => typeof row[series.key] === 'number'))
    )
      context.addIssue({ code: 'custom', message: 'Include at least one numeric value.' });
  });
export const chartBlockSchema = z.union([
  inlineChartSchema,
  z
    .object({
      version: z.literal(1),
      source: z
        .string()
        .max(4500)
        .refine((href) => Boolean(parseResponseReference(href)), 'Use a Mukai file reference.'),
    })
    .strict(),
]);
export type ResponseChart = z.infer<typeof inlineChartSchema>;
export function parseChartBlock(text: string) {
  if (text.length > 65536)
    throw new Error('This chart is too large. Reference a saved chart JSON file instead.');
  try {
    return chartBlockSchema.parse(JSON.parse(text));
  } catch {
    throw new Error(
      'This chart has an invalid format. Use a version 1 bar or line chart with valid series and data.',
    );
  }
}

export function closedChartFence(source: string) {
  const lines = source.trimEnd().split('\n');
  const opening = /^ {0,3}(`{3,}|~{3,})mukai-chart\s*$/.exec(lines[0]);
  if (!opening || lines.length < 2) return false;
  const closing = lines.at(-1)!.trim();
  return (
    closing.length >= opening[1].length && [...closing].every((char) => char === opening[1][0])
  );
}
