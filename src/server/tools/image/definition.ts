import { z } from 'zod';

export const imageDefinition = {
  name: 'image',
  title: 'Image',
  summary: 'Read local image metadata or view an image, including files outside the workspace.',
  actions: ['read', 'view'],
  description:
    'Read local PNG/JPEG/WebP images on the server machine. path: absolute (including outside workspace), or relative to workspace folder. read validates and returns metadata only; view sends image content to a vision model. detail: high (default, max edge 2048px) or original. Limits: 10 MiB, 40 million pixels. Harness handles approval before file access.',
  inputSchema: z
    .object({
      action: z.enum(['read', 'view']),
      path: z.string().min(1).max(4000),
      detail: z.enum(['high', 'original']).optional(),
    })
    .strict(),
};
export type ImageInput = z.infer<typeof imageDefinition.inputSchema>;
