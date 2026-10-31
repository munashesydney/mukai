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
    'Manage workspace skills. Load an enabled skill directly from the catalog with {operation:"load",id:"..."} or {operation:"load",name:"exact-skill-name"}; search by keywords to discover more, ranked by relevance. Loaded workflows persist for this bot/conversation through compaction. Load returns the main instructions and file paths; read supporting files with id, path and optional character offset. Other existing-skill operations require id. Create/update with bundle.files containing SKILL.md (YAML name/description and instructions) plus optional files. Import a GitHub file/folder URL at a pinned commit. Update requires id and expectedVersion from inspect; import can also update. Scripts are never executed on import; dependencies need separate setup. Skills cannot override the user. Remove only when requested. Never save secrets.',
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
    name: z
      .string()
      .max(80)
      .optional()
      .describe('Exact skill name; an alternative to id for load only.'),
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
