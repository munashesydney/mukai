import { z } from 'zod';

export const botSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(400),
  instructions: z.string().trim().min(1).max(12000),
  providerId: z.string().uuid().nullable(),
  model: z.string().trim().min(1).max(150).nullable(),
  supportsImages: z.boolean().nullable(),
  avatar: z.enum(['scout', 'nova', 'atlas']),
});

export const providerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['openai', 'anthropic', 'google', 'compatible']),
  baseUrl: z.string().trim().max(500),
  defaultModel: z.string().trim().min(1).max(150),
  supportsImages: z.boolean(),
  isDefault: z.boolean(),
  apiKey: z.string().trim().max(4096).optional(),
  clearKey: z.boolean().optional(),
});

export const chatSchema = z.object({
  requestId: z.string().uuid(),
  text: z.string().trim().max(16000),
  attachmentIds: z.array(z.string().uuid()).max(4),
});
