import { z } from 'zod';

export const botSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(12000),
  providerId: z.string().uuid().nullable(),
  model: z.string().trim().min(1).max(150).nullable(),
  supportsImages: z.boolean().nullable(),
  avatar: z.enum(['scout', 'nova', 'atlas']),
  contextWindowTokens: z.number().int().min(4096).max(10000000).nullable().optional(),
  maxOutputTokens: z.number().int().min(256).max(262144).nullable().optional(),
});

export const providerSchema = z.object({
  models: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(150),
        name: z.string().trim().min(1).max(150),
        contextWindowTokens: z.number().int().min(4096).max(10000000).nullable(),
        maxOutputTokens: z.number().int().min(256).max(262144),
        supportsImages: z.boolean(),
      }),
    )
    .max(200)
    .refine(
      (models) => new Set(models.map((model) => model.id)).size === models.length,
      'Model IDs must be unique within a provider.',
    )
    .optional(),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['openai', 'chatgpt', 'anthropic', 'google', 'compatible']),
  baseUrl: z.string().trim().max(500),
  defaultModel: z.string().trim().max(150),
  supportsImages: z.boolean(),
  isDefault: z.boolean(),
  apiKey: z.string().trim().max(4096).optional(),
  clearKey: z.boolean().optional(),
  contextWindowTokens: z.number().int().min(4096).max(10000000).nullable().optional(),
  maxOutputTokens: z.number().int().min(256).max(262144).optional(),
});

export const chatSchema = z.object({
  requestId: z.string().uuid(),
  text: z.string().trim().max(16000),
  attachmentIds: z.array(z.string().uuid()).max(4),
});
export const createBotSchema = botSchema.extend({
  workspaceId: z.string().min(1).max(80).optional(),
});
export const botModelSchema = botSchema.pick({
  providerId: true,
  model: true,
  supportsImages: true,
  contextWindowTokens: true,
});
export const workspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    folder: z.string().trim().max(2000).default(''),
    computer: z.enum(['local', 'qemu']).default('local'),
  })
  .refine((input) => input.computer === 'qemu' || Boolean(input.folder), {
    message: 'Choose a local workspace folder.',
    path: ['folder'],
  });
export const spaceSchema = z.object({
  workspaceId: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(400),
  botIds: z.array(z.string().min(1).max(80)).max(50),
});
export const spaceChatSchema = z.object({
  requestId: z.string().uuid(),
  text: z.string().trim().max(16000),
  botId: z.string().min(1).max(80).nullable(),
});
export const savedMessageSchema = z.object({
  messageId: z.string().min(1).max(100),
  saved: z.boolean(),
});
export const spaceImportSchema = z.object({
  workspaceId: z.string().min(1).max(80),
  spaces: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(60),
        description: z.string().max(400),
        messages: z
          .array(
            z.object({
              id: z.string().max(100),
              text: z.string().max(16000),
              author: z.string().max(80),
              saved: z.boolean(),
            }),
          )
          .max(5000),
      }),
    )
    .max(100),
});
