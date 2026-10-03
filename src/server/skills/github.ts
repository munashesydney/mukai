import { createHash } from 'node:crypto';
import { ApiError } from '../config';
import { MAX_BYTES, MAX_FILES, safeSkillPath, validateBundle } from './bundle';
import type { SkillBundle, SkillFile } from '../../shared/skills';

type Fetcher = typeof fetch;
// Only fixed GitHub hosts are contacted. User URLs never become arbitrary fetch targets.
async function githubJson(path: string, signal: AbortSignal, fetcher: Fetcher) {
  const response = await fetcher('https://api.github.com' + path, {
    signal,
    redirect: 'error',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Mukai-Skills' },
  });
  if (!response.ok)
    throw new ApiError(
      400,
      response.status === 403 || response.status === 429
        ? 'GitHub rate limit reached. Try again later.'
        : 'GitHub could not read this public repository (' + response.status + ').',
    );
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(400, 'Empty GitHub response.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024 * 1024) throw new ApiError(400, 'GitHub response is too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'Invalid GitHub response.');
  }
}
export async function importGithub(
  url: string,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<SkillBundle> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(400, 'Paste a GitHub skill file or folder URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    !['github.com', 'raw.githubusercontent.com'].includes(parsed.hostname) ||
    parsed.port ||
    parsed.username ||
    parsed.password
  )
    throw new ApiError(400, 'Only public HTTPS GitHub skill URLs are supported.');
  const parts = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  const [owner, repo] = parts;
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo))
    throw new ApiError(400, 'Invalid GitHub repository URL.');
  let tail: string[];
  if (parsed.hostname === 'github.com') {
    if (!['blob', 'tree'].includes(parts[2]))
      throw new ApiError(400, 'Link to SKILL.md or its containing folder.');
    tail = parts.slice(3);
  } else tail = parts.slice(2);
  if (tail.length < 2) throw new ApiError(400, 'The URL must include a ref and a skill folder.');
  const timed = AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
  const base = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
  // Resolve refs containing slashes, then pin every file fetch to the resolved commit.
  let commit: string | undefined;
  let folder = '';
  const splits = /^(main|master|[a-f0-9]{40})$/.test(tail[0])
    ? [1]
    : Array.from({ length: tail.length - 1 }, (_, index) => tail.length - 1 - index);
  for (const split of splits) {
    try {
      const result = await githubJson(
        base + '/commits/' + encodeURIComponent(tail.slice(0, split).join('/')),
        timed,
        fetcher,
      );
      if (typeof result.sha !== 'string' || !/^[a-f0-9]{40}$/.test(result.sha))
        throw new ApiError(400, 'Invalid GitHub commit.');
      commit = result.sha;
      folder = tail
        .slice(split)
        .join('/')
        .replace(/\/SKILL\.md$/, '');
      break;
    } catch (error) {
      if (!(error instanceof ApiError) || !error.message.includes('(404)')) throw error;
    }
  }
  if (!commit || !folder) throw new ApiError(400, 'GitHub ref or skill folder was not found.');
  let treeId = commit;
  for (const part of folder.split('/')) {
    safeSkillPath(part);
    const directory = await githubJson(base + '/git/trees/' + treeId, timed, fetcher);
    if (!Array.isArray(directory.tree)) throw new ApiError(400, 'Invalid GitHub directory.');
    const next = directory.tree.find((entry: { path: string }) => entry.path === part);
    if (!next || next.type !== 'tree' || !/^[a-f0-9]{40}$/.test(next.sha))
      throw new ApiError(400, 'Skill folder was not found.');
    treeId = next.sha;
  }
  const tree = await githubJson(base + '/git/trees/' + treeId + '?recursive=1', timed, fetcher);
  if (tree.truncated || !Array.isArray(tree.tree))
    throw new ApiError(400, 'Skill folder tree is too large to import safely.');
  const entries = tree.tree.map((entry: { path: string }) => ({
    ...entry,
    path: folder + '/' + entry.path,
  }));
  const blobs = entries.filter((entry: { type: string }) => entry.type !== 'tree');
  if (!blobs.length || blobs.length > MAX_FILES)
    throw new ApiError(400, 'Skill folder must contain between 1 and 100 files.');
  if (
    blobs.some(
      (entry: { mode: string; type: string }) =>
        entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode),
    )
  )
    throw new ApiError(400, 'Skill folders cannot contain symlinks or submodules.');
  if (
    blobs.reduce((sum: number, entry: { size: number }) => sum + (entry.size || 0), 0) > MAX_BYTES
  )
    throw new ApiError(400, 'Skill folder exceeds the 8 MB limit.');
  const files: SkillFile[] = [];
  for (const entry of blobs) {
    if (!/^[a-f0-9]{40}$/.test(entry.sha)) throw new ApiError(400, 'Invalid GitHub blob ID.');
    const blob = await githubJson(base + '/git/blobs/' + entry.sha, timed, fetcher);
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string')
      throw new ApiError(400, 'Unsupported GitHub file encoding.');
    const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
    const actual = createHash('sha1')
      .update('blob ' + bytes.length + '\0')
      .update(bytes)
      .digest('hex');
    if (actual !== entry.sha) throw new ApiError(400, 'GitHub file integrity check failed.');
    let text: string | undefined;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) text = undefined;
    } catch {
      /* preserve binary assets */
    }
    files.push({
      path: entry.path.slice(folder.length + 1),
      encoding: text === undefined ? 'base64' : 'utf8',
      content: text === undefined ? bytes.toString('base64') : text,
    });
  }
  const bundle = { files, source: { url, repository: owner + '/' + repo, commit, folder } };
  timed.throwIfAborted();
  return validateBundle(bundle).bundle;
}
