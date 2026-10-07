import { basename, join, relative, resolve, sep } from 'node:path';
import { mkdir, lstat, realpath, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { ApiError } from '../config';
import { ArtifactRepository } from '../repositories/artifactRepository';
import { BotRepository } from '../repositories/botRepository';
import { WorkspaceService } from './workspaceService';
import { WorkspaceFileService } from './workspaceFileService';

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
  record(botId: string, messageId: string, path: string) {
    this.artifacts.save({
      id: randomUUID(),
      botId,
      messageId,
      path,
      name: basename(path),
      createdAt: new Date().toISOString(),
    });
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
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      await unlink(path);
      throw error;
    }
    return { artifactId: id, path, width, height };
  }
  async read(id: string) {
    const artifact = this.artifacts.find(id);
    const bot = artifact && this.bots.find(artifact.botId);
    if (!artifact || !bot) throw new ApiError(404, 'Artifact not found.');
    const workspace = this.workspaces.require(bot.workspaceId);
    if (artifact.kind === 'image') {
      const name = artifact.id + '.png';
      const folders = [
        this.screenshotFolder(bot.workspaceId),
        join(this.dataDir, 'artifacts', 'screenshots', bot.workspaceId),
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
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.nlink > 1 || opened.size > SCREENSHOT_LIMIT)
          throw new ApiError(400, 'The screenshot artifact is unavailable.');
        const bytes = Buffer.alloc(Math.min(opened.size + 1, SCREENSHOT_LIMIT + 1));
        let length = 0;
        while (length < bytes.length) {
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
      const result = (await this.workspaces
        .computers!.guest(workspace)
        .request(
          'download',
          { path: artifact.path },
          { workspaceId: workspace.id, botId: bot.id, conversationId: 'artifact-download' },
          AbortSignal.timeout(45000),
        )) as { name: string; bytes: string };
      return {
        name: result.name,
        bytes: Buffer.from(result.bytes, 'base64'),
        mediaType: 'text/plain; charset=utf-8',
      };
    }
    if (!workspace.folder) throw new ApiError(400, 'This workspace has no folder.');
    return {
      ...(await new WorkspaceFileService(workspace.folder, this.dataDir).download(artifact.path)),
      mediaType: 'text/plain; charset=utf-8',
    };
  }
}
