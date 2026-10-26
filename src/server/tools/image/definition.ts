import { z } from 'zod';

export const imageDefinition = {
  name: 'image',
  title: 'Image',
  summary: 'Read local image metadata or view an image, including files outside the workspace.',
  actions: ['read', 'view'],
  description:
    'Read PNG/JPEG/WebP metadata or view pixels. Supply exactly one path (absolute or workspace-relative on the active computer), attachmentId (saved upload), or artifactId (generated file/screenshot). IDs come from conversations.list_artifacts/search_artifacts and work in local/VM mode without copying. read validates metadata only; view requires a vision model. detail: high (default, max edge 2048px) or original. Limits: 10 MiB, 40 million pixels. Harness handles file approval.',
  inputSchema: z
    .object({
      action: z.enum(['read', 'view']),
      path: z.string().min(1).max(4000).optional(),
      attachmentId: z.string().min(1).max(200).optional(),
      artifactId: z.string().min(1).max(200).optional(),
      detail: z.enum(['high', 'original']).optional(),
    })
    .strict()
    .superRefine((input, ctx) => {
      if (
        [input.path, input.attachmentId, input.artifactId].filter((value) => value !== undefined)
          .length !== 1
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Supply exactly one path, attachmentId, or artifactId.',
        });
    }),
};
export type ImageInput = z.infer<typeof imageDefinition.inputSchema>;
