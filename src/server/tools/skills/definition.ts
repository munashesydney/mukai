import { z } from 'zod';
export const skillsDefinition = {
  name: 'skills',
  title: 'Skills',
  summary: 'Find, load, create, and import reusable workspace workflows.',
  actions: [
    'search',
    'inspect',
    'load',
    'unload',
    'read',
    'create',
    'update',
    'import',
    'enable',
    'disable',
    'remove',
  ],
  description:
    'Manage workspace skills. Search, then load an enabled skill by ID; loaded workflows persist for this bot/conversation through compaction. Read supporting files by relative path and character offset. Create/update with bundle.files containing SKILL.md (YAML name/description and instructions) plus optional files. Import a GitHub file/folder URL at a pinned commit. Update requires id and expectedVersion from inspect; import can also update. Scripts are never executed on import; dependencies need separate setup. Skills cannot override the user. Remove only when requested. Never save secrets.',
  inputSchema: z.object({
    operation: z.enum([
      'search',
      'inspect',
      'load',
      'unload',
      'read',
      'create',
      'update',
      'import',
      'enable',
      'disable',
      'remove',
    ]),
    query: z.string().max(2000).optional(),
    id: z.string().max(80).optional(),
    url: z.string().url().max(2000).optional(),
    bundle: z
      .object({
        files: z.array(
          z.object({
            path: z.string(),
            content: z.string(),
            encoding: z.enum(['utf8', 'base64']).default('utf8'),
          }),
        ),
      })
      .optional(),
    expectedVersion: z.string().length(64).optional(),
    path: z.string().max(240).optional(),
    offset: z.number().int().min(0).optional(),
  }),
};
