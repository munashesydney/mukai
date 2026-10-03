import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { ApiError } from '../config';
import type { SkillBundle } from '../../shared/skills';

export const MAX_FILES = 100;
export const MAX_BYTES = 8 * 1024 * 1024;
export const bundleSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(240),
        content: z.string().max(MAX_BYTES * 2),
        encoding: z.enum(['utf8', 'base64']),
      }),
    )
    .min(1)
    .max(MAX_FILES),
  source: z
    .object({
      url: z.string().url().max(2000),
      repository: z.string().max(240),
      commit: z.string().regex(/^[a-f0-9]{40}$/),
      folder: z.string().max(1000),
    })
    .optional(),
});
export function safeSkillPath(path: string) {
  if (
    path.includes('\\') ||
    path.startsWith('/') ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[<>:"|?*]/.test(part) ||
          [...part].some((char) => char.charCodeAt(0) < 32) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part),
      )
  )
    throw new ApiError(400, 'Skill files must use safe relative paths.');
  return path;
}
export function validateBundle(value: unknown) {
  const bundle = bundleSchema.parse(value);
  const names = new Set<string>();
  let bytes = 0;
  for (const file of bundle.files) {
    safeSkillPath(file.path);
    const key = file.path.toLowerCase();
    if (names.has(key)) throw new ApiError(400, 'Duplicate skill file path.');
    names.add(key);
    if (
      file.encoding === 'base64' &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)
    )
      throw new ApiError(400, 'Invalid binary file encoding.');
    bytes += Buffer.byteLength(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    if (bytes > MAX_BYTES) throw new ApiError(400, 'Skill folder exceeds the 8 MB limit.');
  }
  const entry = bundle.files.find((file) => file.path === 'SKILL.md');
  if (!entry || entry.encoding !== 'utf8' || Buffer.byteLength(entry.content) > 128 * 1024)
    throw new ApiError(400, 'A UTF-8 SKILL.md of at most 128 KB is required at the folder root.');
  const match = entry.content
    .replace(/^\uFEFF/, '')
    .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new ApiError(400, 'SKILL.md needs YAML frontmatter with name and description.');
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw new ApiError(400, 'Invalid SKILL.md YAML frontmatter.');
  let metadata: unknown;
  try {
    metadata = doc.toJS({ maxAliasCount: 20 });
  } catch {
    throw new ApiError(400, 'Invalid SKILL.md metadata aliases.');
  }
  const parsed = z
    .object({
      name: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(64),
      description: z.string().trim().min(1).max(2000),
      'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .safeParse(metadata);
  if (!parsed.success || !match[2].trim())
    throw new ApiError(
      400,
      'Skill requires a lowercase hyphenated name, a description, and instructions.',
    );
  const requirements: string[] = [];
  const allowed = parsed.data['allowed-tools'];
  if (allowed)
    requirements.push('Declared tools: ' + (Array.isArray(allowed) ? allowed.join(', ') : allowed));
  if (parsed.data.metadata?.requires)
    requirements.push(
      'Declared requirements: ' + JSON.stringify(parsed.data.metadata.requires).slice(0, 1000),
    );
  bundle.files.sort((a, b) => a.path.localeCompare(b.path));
  const version = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  return {
    bundle: bundle as SkillBundle,
    name: parsed.data.name,
    description: parsed.data.description,
    requirements,
    bytes,
    version,
    body: match[2].trim(),
  };
}
