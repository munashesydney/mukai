import { constants } from 'node:fs';
import {
  lstat,
  realpath,
  readFile,
  readdir,
  writeFile,
  mkdir,
  rename,
  unlink,
  copyFile,
  open,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../config';
import type { FileOperationsInput } from '../tools/file-operations/definition';
import type { FileMutationSnapshot } from '../../shared/fileChanges';
import { patchText } from './patchText';
import { fileMetadata } from './fileMetadata';

const FILE_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 24000;
const mutationLocks = new Map<string, Promise<void>>();
const protectedNames = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.codex',
  '.agents',
  '.mukai',
  '.dev-data',
  'node_modules',
  'credentials.key',
  'api.token',
  'server.lock',
]);
const protectedName = (name: string) =>
  protectedNames.has(name.toLowerCase()) || /^\.env|^\.mukai-write-|\.(?:pem|key)$/i.test(name);
const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path));
};

export class WorkspaceFileService {
  constructor(
    private folder: string,
    private privateDir: string,
    private onFileChanged?: (snapshot: FileMutationSnapshot) => void,
  ) {}
  private recordChange(snapshot: FileMutationSnapshot) {
    try {
      this.onFileChanged?.(snapshot);
      return [] as string[];
    } catch (error) {
      console.error('[mukai file bookkeeping]', error);
      return ['The file was saved, but its change history could not be recorded.'];
    }
  }
  private async root() {
    try {
      const canonical = await realpath(this.folder);
      if (resolve(canonical).toLowerCase() !== resolve(this.folder).toLowerCase())
        throw new ApiError(
          400,
          'The workspace folder moved or became a link. Choose its current folder in a new workspace.',
        );
      if (!(await lstat(canonical)).isDirectory()) throw new Error();
      return canonical;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        400,
        'The workspace folder is unavailable. Reconnect the folder before using files.',
      );
    }
  }
  async path(value = '.', allowMissing = false, allowAbsolute = false) {
    const absolute = allowAbsolute && isAbsolute(value);
    const root = absolute ? parse(resolve(value)).root : await this.root();
    const normalized = (absolute ? relative(root, resolve(value)) : value).replace(/\\/g, '/');
    if (
      (!absolute && isAbsolute(value)) ||
      normalized.startsWith('/') ||
      normalized.includes(':') ||
      normalized.includes('\0')
    )
      throw new ApiError(400, 'Use a relative path inside the workspace folder.');
    const parts = normalized.split('/').filter((part) => part && part !== '.');
    if (
      parts.some(
        (part) =>
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
          protectedName(part),
      )
    )
      throw new ApiError(
        400,
        'That path is outside the allowed workspace files or contains a protected name.',
      );
    const target = resolve(root, ...parts);
    if (!inside(root, target) || inside(resolve(this.privateDir), target))
      throw new ApiError(
        400,
        'Access outside the workspace or to Mukai’s private data is blocked.',
      );
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = resolve(current, parts[index]);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !inside(root, await realpath(current)))
          throw new ApiError(400, 'Links and junctions cannot be accessed by file tools.');
        if (info.isFile() && info.nlink > 1)
          throw new ApiError(400, 'Hard-linked files cannot be accessed by file tools.');
        if (index < parts.length - 1 && !info.isDirectory())
          throw new ApiError(400, 'A parent path is not a directory.');
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'ENOENT' &&
          allowMissing &&
          index === parts.length - 1
        )
          break;
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, 'The requested file or directory is unavailable.');
      }
    }
    return { absolute: target, relative: parts.join('/') || '.' };
  }
  private async text(value: string) {
    const target = await this.path(value);
    const info = await lstat(target.absolute);
    if (!info.isFile() || info.size > FILE_LIMIT)
      throw new ApiError(400, 'Read a regular text file up to 256 KB.');
    // O_NOFOLLOW prevents a final-component link swap where the platform supports it.
    const bytes = await readFile(target.absolute, {
      flag: constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    });
    if (bytes.length > FILE_LIMIT)
      throw new ApiError(400, 'This file exceeds the 256 KB text limit.');
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (text.includes('\0')) throw new Error();
      return { ...target, text };
    } catch {
      throw new ApiError(
        400,
        'This file is not readable UTF-8 text. Binary files are unsupported.',
      );
    }
  }
  async download(value: string, maxBytes = FILE_LIMIT, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const target = await this.path(value);
    const file = await open(target.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink > 1 || info.size > maxBytes)
        throw new ApiError(400, 'This artifact is unavailable or exceeds the file limit.');
      const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
      let length = 0;
      while (length < bytes.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > info.size || length > maxBytes)
        throw new ApiError(400, 'This artifact exceeds the file limit.');
      return { name: basename(target.absolute), bytes: bytes.subarray(0, length) };
    } finally {
      await file.close();
    }
  }
  async inspect(value: string) {
    const target = await this.path(value);
    if (!(await lstat(target.absolute)).isFile())
      throw new ApiError(400, 'Inspect a regular workspace file.');
    const file = await open(target.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink > 1)
        throw new ApiError(400, 'Inspect a regular workspace file.');
      const header = Buffer.alloc(Math.min(info.size, 4096));
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      return fileMetadata(header.subarray(0, bytesRead), target.absolute, info.size);
    } finally {
      await file.close();
    }
  }
  private async save(
    value: string,
    content: string | Buffer,
    overwrite: boolean,
    signal: AbortSignal,
    importing = false,
  ) {
    if (
      importing
        ? Buffer.byteLength(content) > 10 * 1024 * 1024
        : Buffer.byteLength(content) > FILE_LIMIT || content.includes('\0')
    )
      throw new ApiError(400, 'Write UTF-8 text up to 256 KB.');
    const target = await this.path(value, true, importing);
    if (target.relative === '.') throw new ApiError(400, 'Choose a file path.');
    signal.throwIfAborted();
    const temporary = resolve(dirname(target.absolute), `.mukai-write-${randomUUID()}.tmp`);
    let committed = false;
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600, signal });
      await this.path(value, true, importing);
      signal.throwIfAborted();
      if (overwrite) await rename(temporary, target.absolute);
      else {
        try {
          await copyFile(temporary, target.absolute, constants.COPYFILE_EXCL);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw new ApiError(
              409,
              'The file already exists. Read it and use patch, or explicitly set overwrite.',
            );
          throw error;
        }
      }
      committed = true;
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          if (!committed) throw error;
          console.error('[mukai temporary file cleanup]', error);
        }
      });
    }
    return importing ? target.absolute : target.relative;
  }
  async execute(input: FileOperationsInput, signal: AbortSignal) {
    if (!['write_file', 'patch', 'create_directory'].includes(input.action))
      return this.executeAction(input, signal);
    return this.mutate(input.path || '.', signal, () => this.executeAction(input, signal));
  }
  async copyAttachment(path: string, bytes: Buffer, overwrite: boolean, signal: AbortSignal) {
    if (!this.folder && !isAbsolute(path))
      throw new ApiError(400, 'Use an absolute destination when this workspace has no folder.');
    return this.mutate(path, signal, async () => {
      const destination = await this.save(path, bytes, overwrite, signal, true);
      const artifactPath =
        this.folder && inside(resolve(this.folder), destination)
          ? relative(resolve(this.folder), destination).split(sep).join('/')
          : undefined;
      return {
        path: destination,
        changed: true,
        ...(artifactPath ? { artifactPath } : {}),
        bytes: bytes.length,
        metadata: fileMetadata(bytes.subarray(0, 4096), destination, bytes.length),
        summary: `Copied attachment to ${destination}.`,
      };
    });
  }
  private async mutate<T>(value: string, signal: AbortSignal, execute: () => Promise<T>) {
    // Reserve the queue position before any asynchronous validation, preserving call order.
    // This path is only a lock key; executeAction validates it before touching the filesystem.
    const target = resolve(this.folder, value.replace(/\\/g, '/'));
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    const previous = mutationLocks.get(key) || Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    mutationLocks.set(key, current);
    try {
      await previous;
      signal.throwIfAborted();
      return await execute();
    } finally {
      unlock();
      if (mutationLocks.get(key) === current) mutationLocks.delete(key);
    }
  }
  private async executeAction(input: FileOperationsInput, signal: AbortSignal) {
    signal.throwIfAborted();
    const value = input.path || '.';
    switch (input.action) {
      case 'copy_attachment':
        throw new ApiError(400, 'copy_attachment must resolve a saved upload through the host.');
      case 'list': {
        const target = await this.path(value);
        const entries = (await readdir(target.absolute, { withFileTypes: true }))
          .filter(
            (entry) =>
              !entry.isSymbolicLink() &&
              !protectedName(entry.name) &&
              !inside(resolve(this.privateDir), resolve(target.absolute, entry.name)),
          )
          .sort((a, b) => a.name.localeCompare(b.name));
        return {
          path: target.relative,
          summary: `Listed ${Math.min(entries.length, 200)} entries.`,
          entries: entries.slice(0, 200).map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory() ? 'directory' : 'file',
          })),
          truncated: entries.length > 200,
        };
      }
      case 'read_file': {
        const file = await this.text(value);
        const lines = file.text.split('\n'),
          start = input.startLine || 1;
        const end = Math.min(input.endLine || start + 199, start + 199, lines.length);
        if (end < start) throw new ApiError(400, 'The requested line range is outside this file.');
        const text = lines.slice(start - 1, end).join('\n');
        return {
          path: file.relative,
          summary: `Read lines ${start}–${end} of ${lines.length}.`,
          content: text.slice(0, OUTPUT_LIMIT),
          startLine: start,
          endLine: end,
          totalLines: lines.length,
          truncated: text.length > OUTPUT_LIMIT || end < lines.length,
        };
      }
      case 'write_file': {
        if (input.content === undefined)
          throw new ApiError(400, 'content is required for write_file.');
        const target = await this.path(value, true);
        let before: string | null = null;
        try {
          await lstat(target.absolute);
          // Existing-file overwrites need readable contents for an accurate snapshot.
          before = (await this.text(value)).text;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const path = await this.save(value, input.content, input.overwrite === true, signal);
        const warnings = this.recordChange({ path, before, after: input.content });
        return {
          path,
          changed: true,
          metadata: fileMetadata(Buffer.from(input.content), path),
          warnings,
          summary: `Saved ${path}.`,
        };
      }
      case 'patch': {
        if (!input.oldText || input.newText === undefined)
          throw new ApiError(400, 'patch needs nonempty oldText and newText.');
        const file = await this.text(value);
        const after = patchText(file.text, input.oldText, input.newText);
        const latest = await this.text(value);
        if (latest.text !== file.text)
          throw new ApiError(409, 'The file changed while patching. Read it again.');
        const path = await this.save(value, after, true, signal);
        const warnings = this.recordChange({ path, before: file.text, after });
        return {
          path,
          changed: true,
          metadata: fileMetadata(Buffer.from(after), path),
          warnings,
          summary: `Patched ${path}.`,
        };
      }
      case 'create_directory': {
        const target = await this.path(value, true);
        signal.throwIfAborted();
        try {
          await mkdir(target.absolute);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            !(await lstat(target.absolute)).isDirectory()
          )
            throw error;
        }
        return { path: target.relative, summary: `Directory ${target.relative} is ready.` };
      }
      case 'search_files': {
        if (!input.query) throw new ApiError(400, 'query is required for search_files.');
        const start = await this.path(value);
        if ((await lstat(start.absolute)).isFile()) {
          signal.throwIfAborted();
          const file = await this.text(start.relative);
          const matches = file.text
            .split('\n')
            .flatMap((line, index) =>
              line.toLowerCase().includes(input.query!.toLowerCase())
                ? [{ path: file.relative, line: index + 1, text: line.slice(0, 240) }]
                : [],
            );
          return {
            path: file.relative,
            summary: `Found ${Math.min(matches.length, 100)} matching lines.`,
            matches: matches.slice(0, 100),
            truncated: matches.length > 100,
          };
        }
        const queue = [start.relative];
        const matches: { path: string; line: number; text: string }[] = [];
        let visited = 0;
        while (queue.length && visited < 5000 && matches.length < 100) {
          signal.throwIfAborted();
          const directory = await this.path(queue.shift()!);
          for (const entry of await readdir(directory.absolute, { withFileTypes: true })) {
            if (++visited > 5000 || matches.length >= 100) break;
            if (
              entry.isSymbolicLink() ||
              protectedName(entry.name) ||
              inside(resolve(this.privateDir), resolve(directory.absolute, entry.name))
            )
              continue;
            const name = `${directory.relative === '.' ? '' : directory.relative + '/'}${entry.name}`;
            if (entry.isDirectory()) queue.push(name);
            else if (entry.isFile()) {
              try {
                const file = await this.text(name);
                for (const [index, line] of file.text.split('\n').entries()) {
                  if (line.toLowerCase().includes(input.query.toLowerCase()))
                    matches.push({ path: name, line: index + 1, text: line.slice(0, 240) });
                  if (matches.length >= 100) break;
                }
              } catch {
                /* Skip protected, binary, too-large, or concurrently removed files. */
              }
            }
          }
        }
        return {
          path: start.relative,
          summary: `Found ${matches.length} matching lines.`,
          matches,
          truncated: visited >= 5000 || matches.length >= 100,
        };
      }
    }
  }
}
