import { z } from 'zod';

export const profileIconIds = [
  'user',
  'sparkles',
  'rocket',
  'cat',
  'ghost',
  'leaf',
  'coffee',
  'music',
  'gamepad',
  'star',
  'sun',
  'smile',
] as const;
export const userProfileSchema = z
  .object({
    mode: z.enum(['letter', 'icon']),
    letter: z
      .string()
      .trim()
      .min(1)
      .max(2)
      .regex(/^[\p{L}\p{N}]{1,2}$/u),
    icon: z.enum(profileIconIds),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict();
export type UserProfile = z.infer<typeof userProfileSchema>;
export const defaultUserProfile: UserProfile = {
  mode: 'icon',
  letter: 'U',
  icon: 'user',
  background: '#b28a66',
};
