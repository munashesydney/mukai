import { basename, join, relative, resolve, sep, isAbsolute, posix } from 'node:path';
import { mkdir, lstat, realpath, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { z } from 'zod';
import { executeImage } from '../tools/image/execute';
import { ApiError } from '../config';
import { ArtifactRepository } from '../repositories/artifactRepository';
import { BotRepository } from '../repositories/botRepository';
import { WorkspaceService } from './workspaceService';
import { WorkspaceFileService } from './workspaceFileService';
import type { FileArtifact, Workspace } from '../../shared/ai';
import type { FileMetadata } from '../../shared/fileMetadata';
import { fileMetadata } from './fileMetadata';
import { artifactHref } from '../../shared/responseReferences';
import { downloadGuestFile } from '../computer/downloadFile';

const SCREENSHOT_LIMIT = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const samePath = (left: string, right: string) =>
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);

export class ArtifactService {
  constructor(
    private artifacts: ArtifactRepository,
    private bots: BotRepository,
    private workspaces: WorkspaceService,
    private dataDir: string,
  ) {}
  list(botId: string) {
    return this.artifacts.list(botId);
  }
  forConversation(id: string) {
    return this.artifacts.forConversation(id);
  }
  async previewImage(botId: string, conversationId: string, path: string) {
    const bot = this.bots.find(botId);
    if (!bot) throw new ApiError(404, 'Bot not found.');
    const workspace = this.workspaces.require(bot.workspaceId);
    const owner = { workspaceId: workspace.id, botId, conversationId };
    const signal = AbortSignal.timeout(45000);
    try {
      let result: unknown;
      if (workspace.computer === 'qemu') {
        result = await this.workspaces
          .computers!.guest(workspace)
          .request('image', { action: 'view', path }, owner, signal);
      } else {
        const output = await executeImage(
          { action: 'view', path },
          {
            owner,
            signal,
            folder: workspace.folder,
            vision: true,
            budget: { remaining: 1 },
            onActivity: () => {},
          },
          'image-preview',
        );
        if (!output.ok) throw new ApiError(400, output.error!);
        result = output.result;
      }
      const image = z.object({ image: z.string().max(14 * 1024 * 1024) }).parse(result);
      return Buffer.from(image.image, 'base64');
    } catch (error) {
      if (
        error instanceof Error &&
        ((!('code' in error) && /^(ENOENT|ENOTDIR):/.test(error.message)) ||
          error.message === 'The requested file or directory is unavailable.')
      )
        throw new ApiError(
          404,
          'This image is no longer available. It may have been moved, deleted, or become inaccessible.',
        );
      throw error;
    }
  }
  record(botId: string, messageId: string, path: string, metadata?: FileMetadata) {
    const file = this.artifacts.save({
      id: randomUUID(),
      botId,
      messageId,
      path,
      name: basename(path),
      createdAt: new Date().toISOString(),
      ...metadata,
    });
    return { artifactId: file.id, reference: artifactHref(file.id) };
  }
  private screenshotFolder(workspaceId: string) {
    const workspace = this.workspaces.require(workspaceId);
    return workspace.computer !== 'qemu' && workspace.folder
      ? join(workspace.folder, '.mukai', 'artifacts', 'screenshots')
      : join(this.dataDir, 'artifacts', 'screenshots', workspaceId);
  }
  async recordScreenshot(botId: string, messageId: string, image: string, signal: AbortSignal) {
    const bot = this.bots.find(botId);
    if (!bot) throw new ApiError(404, 'Bot not found.');
    if (image.length > Math.ceil(SCREENSHOT_LIMIT / 3) * 4)
      throw new ApiError(413, 'Screenshot exceeds the 16 MiB artifact limit.');
    const bytes = Buffer.from(image, 'base64');
    if (bytes.length > SCREENSHOT_LIMIT)
      throw new ApiError(413, 'Screenshot exceeds the 16 MiB artifact limit.');
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
      throw new ApiError(400, 'The browser did not return a PNG screenshot.');
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (!width || !height) throw new ApiError(400, 'The screenshot has invalid dimensions.');
    signal.throwIfAborted();
    const folder = resolve(this.screenshotFolder(bot.workspaceId));
    const workspace = this.workspaces.require(bot.workspaceId);
    const root = resolve(
      workspace.computer === 'qemu' ? this.dataDir : workspace.folder || this.dataDir,
    );
    const parts = relative(root, folder).split(sep);
    let current = root;
    for (const part of ['', ...parts]) {
      current = resolve(current, part);
      if (part)
        await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const info = await lstat(current);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !samePath(await realpath(current), current)
      )
        throw new ApiError(400, 'The screenshot artifact folder cannot be a link or junction.');
    }
    const id = randomUUID(),
      name = id + '.png',
      path = join(folder, name);
    const file = await open(path, 'wx', 0o600);
    try {
      try {
        await file.writeFile(bytes, { signal });
      } finally {
        await file.close();
      }
      signal.throwIfAborted();
      this.artifacts.save({
        id,
        botId,
        messageId,
        path,
        name,
        kind: 'image',
        mediaType: 'image/png',
        size: bytes.length,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      await unlink(path);
      throw error;
    }
    return { artifactId: id, reference: artifactHref(id), path, width, height };
  }
  async readPath(
    workspaceId: string,
    path: string,
    signal: AbortSignal,
    maxBytes = 10 * 1024 * 1024,
  ) {
    const workspace = this.workspaces.require(workspaceId);
    let relativePath = path;
    if (workspace.computer === 'qemu') {
      if (posix.isAbsolute(path)) {
        const normalized = posix.normalize(path);
        if (!normalized.startsWith('/home/mukai/workspace/'))
          throw new ApiError(403, 'File references must stay inside this workspace.');
        relativePath = normalized.slice('/home/mukai/workspace/'.length);
      }
      if (/^[a-z]:|^\\\\/i.test(path))
        throw new ApiError(403, 'Use a path inside the workspace VM.');
    } else {
      if (!workspace.folder)
        throw new ApiError(400, 'Connect a workspace folder before opening file paths.');
      if (isAbsolute(path)) relativePath = relative(resolve(workspace.folder), resolve(path));
    }
    try {
      signal.throwIfAborted();
      const file =
        workspace.computer === 'qemu'
          ? await downloadGuestFile(
              this.workspaces.computers!.guest(workspace),
              relativePath,
              { workspaceId, botId: 'reference-preview', conversationId: 'reference-preview' },
              signal,
              maxBytes,
            )
          : await new WorkspaceFileService(workspace.folder!, this.dataDir).download(
              relativePath,
              maxBytes,
              signal,
            );
      const bytes = file.bytes;
      return {
        name: file.name,
        bytes,
        ...fileMetadata(bytes.subarray(0, 4096), file.name, bytes.length),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'The requested file or directory is unavailable.' ||
          /^(ENOENT|ENOTDIR):/.test(error.message))
      )
        throw new ApiError(
          404,
          'This file is no longer available. It may have been moved or deleted.',
        );
      throw error;
    }
  }
  async read(id: string, signal = AbortSignal.timeout(45000), maxBytes = 10 * 1024 * 1024) {
    signal.throwIfAborted();
    const artifact = this.artifacts.find(id);
    const bot = artifact && this.bots.find(artifact.botId);
    if (!artifact || !bot) throw new ApiError(404, 'Artifact not found.');
    const workspace = this.workspaces.require(bot.workspaceId);
    try {
      const result = await this.readFile(artifact, workspace, signal, maxBytes);
      const metadata = fileMetadata(
        result.bytes.subarray(0, 4096),
        result.name,
        result.bytes.length,
      );
      this.artifacts.updateMetadata(id, metadata);
      return { ...result, mediaType: metadata.mediaType };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const vmFile = workspace.computer === 'qemu' && artifact.kind !== 'image';
      // Guest file errors currently cross the bridge as plain Errors, without
      // their ApiError status. Recognize only the known unavailable-path reply.
      if (
        (!vmFile && (code === 'ENOENT' || code === 'ENOTDIR')) ||
        (error instanceof Error &&
          error.message === 'The requested file or directory is unavailable.')
      ) {
        const location =
          workspace.computer === 'qemu' ? 'the workspace VM' : 'the workspace folder';
        throw new ApiError(
          404,
          artifact.kind === 'image'
            ? 'This saved screenshot is no longer available. It may have been moved or deleted.'
            : `This file is no longer available in ${location}. It may have been moved, deleted, or become inaccessible.`,
        );
      }
      throw error;
    }
  }
  async inspect(id: string, signal = AbortSignal.timeout(5000)) {
    signal.throwIfAborted();
    const artifact = this.artifacts.find(id);
    const bot = artifact && this.bots.find(artifact.botId);
    if (!artifact || !bot) throw new ApiError(404, 'Artifact not found.');
    const workspace = this.workspaces.require(bot.workspaceId);
    let metadata: FileMetadata;
    if (artifact.kind === 'image') {
      const file = await this.openScreenshot(artifact, workspace);
      try {
        metadata = { mediaType: 'image/png', size: (await file.stat()).size };
      } finally {
        await file.close();
      }
    } else if (workspace.computer === 'qemu') {
      // Discovery must never start a stopped VM just to fill in optional metadata.
      if (this.workspaces.computers?.status(workspace).state !== 'running') return null;
      metadata = z
        .object({ mediaType: z.string(), size: z.number().int().nonnegative() })
        .parse(
          await this.workspaces.computers
            .guest(workspace)
            .request(
              'files',
              { action: 'inspect_artifact', path: artifact.path },
              { workspaceId: workspace.id, botId: bot.id, conversationId: 'artifact-inspect' },
              signal,
            ),
        );
    } else {
      if (!workspace.folder) return null;
      metadata = await new WorkspaceFileService(workspace.folder, this.dataDir).inspect(
        artifact.path,
      );
    }
    this.artifacts.updateMetadata(id, metadata);
    return metadata;
  }
  private async openScreenshot(artifact: FileArtifact, workspace: Workspace) {
    const name = artifact.id + '.png';
    const folders = [
      this.screenshotFolder(workspace.id),
      join(this.dataDir, 'artifacts', 'screenshots', workspace.id),
    ].map((folder) => resolve(folder));
    const folder = folders.find(
      (candidate) => resolve(join(candidate, name)) === resolve(artifact.path),
    );
    if (!folder || !samePath(await realpath(folder), folder))
      throw new ApiError(400, 'The screenshot artifact is outside its managed storage.');
    const info = await lstat(artifact.path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > SCREENSHOT_LIMIT)
      throw new ApiError(400, 'The screenshot artifact is unavailable.');
    const file = await open(artifact.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await file.stat().catch(async (error) => {
      await file.close();
      throw error;
    });
    if (!opened.isFile() || opened.nlink > 1 || opened.size > SCREENSHOT_LIMIT) {
      await file.close();
      throw new ApiError(400, 'The screenshot artifact is unavailable.');
    }
    return file;
  }
  private async readFile(
    artifact: FileArtifact,
    workspace: Workspace,
    signal: AbortSignal,
    maxBytes: number,
  ) {
    if (artifact.kind === 'image') {
      const file = await this.openScreenshot(artifact, workspace);
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.nlink > 1 || opened.size > SCREENSHOT_LIMIT)
          throw new ApiError(400, 'The screenshot artifact is unavailable.');
        const bytes = Buffer.alloc(Math.min(opened.size + 1, SCREENSHOT_LIMIT + 1));
        let length = 0;
        while (length < bytes.length) {
          signal.throwIfAborted();
          const chunk = await file.read(bytes, length, bytes.length - length, null);
          if (!chunk.bytesRead) break;
          length += chunk.bytesRead;
        }
        if (length > opened.size || length > SCREENSHOT_LIMIT)
          throw new ApiError(413, 'The screenshot artifact exceeds its limit.');
        return { name: artifact.name, bytes: bytes.subarray(0, length), mediaType: 'image/png' };
      } finally {
        await file.close();
      }
    }
    if (workspace.computer === 'qemu') {
      const result = await downloadGuestFile(
        this.workspaces.computers!.guest(workspace),
        artifact.path,
        { workspaceId: workspace.id, botId: artifact.botId, conversationId: 'artifact-download' },
        signal,
        maxBytes,
      );
      return {
        name: result.name,
        bytes: result.bytes,
        mediaType: 'text/plain; charset=utf-8',
      };
    }
    if (!workspace.folder) throw new ApiError(400, 'This workspace has no folder.');
    return {
      ...(await new WorkspaceFileService(workspace.folder, this.dataDir).download(
        artifact.path,
        maxBytes,
        signal,
      )),
      mediaType: 'text/plain; charset=utf-8',
    };
  }
}
