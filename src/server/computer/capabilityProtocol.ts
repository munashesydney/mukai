import { z } from 'zod';

const boundedText = (bytes: number) =>
  z
    .string()
    .refine(
      (value) => Buffer.byteLength(value) <= bytes,
      'Capability text exceeds its byte limit.',
    );
export const compiledCapability = z.object({
  output: boundedText(10 * 1024 * 1024),
  source: boundedText(262144),
  sources: z.record(z.string(), boundedText(262144)),
});
export const capabilityInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('compile'), modulePath: z.string().min(1).max(4000) }),
  z.object({
    operation: z.literal('run'),
    code: boundedText(10 * 1024 * 1024),
    timeoutMs: z.number().int().min(100).max(30000),
    data: z.object({
      exportName: z.string().min(1).max(100),
      kind: z.enum(['tool', 'route', 'job']).optional(),
      operation: z.enum(['validate', 'execute', 'handle', 'processJob', 'runJob']),
      env: z.record(z.string(), z.string()),
      workspaceId: z.string(),
      input: z.unknown().optional(),
    }),
  }),
]);
export const capabilityResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.string().max(2000),
    status: z.number().int().min(400).max(599),
  }),
]);
