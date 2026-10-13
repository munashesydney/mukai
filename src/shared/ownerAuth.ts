import { z } from 'zod';

export const ownerCredentialsSchema = z
  .object({
    username: z
      .string({ error: 'Enter a username or email address.' })
      .trim()
      .min(3, 'Username must be at least 3 characters.')
      .max(254, 'Username must be 254 characters or fewer.')
      .regex(/^[^\s\p{Cc}]+$/u, 'Username cannot contain spaces or control characters.'),
    password: z
      .string({ error: 'Enter a password.' })
      .min(10, 'Password must be at least 10 characters.')
      .max(256, 'Password must be 256 characters or fewer.'),
  })
  .strict();
