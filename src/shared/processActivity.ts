import { z } from 'zod';

export const PROCESS_ACTIVITY_URL_LIMIT = 16;
export const PROCESS_ACTIVITY_URL_LENGTH = 2048;
export const processActivitySchema = z
  .array(
    z.object({
      id: z.string().uuid(),
      status: z.enum(['running', 'exited', 'killed', 'failed']),
      serverUrls: z
        .array(z.string().max(PROCESS_ACTIVITY_URL_LENGTH))
        .max(PROCESS_ACTIVITY_URL_LIMIT),
    }),
  )
  .max(256);
export type ProcessActivity = z.infer<typeof processActivitySchema>[number];
