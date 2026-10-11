import { z } from 'zod';
import { localServerUrl, serverUrls, type ChatServerOutput } from '../../shared/chatActivity';
import type { RuntimeOwner, BrowserSession } from '../../shared/runtime';
import type { ChatOutputRepository } from '../repositories/chatOutputRepository';
import type { ConversationService } from './conversationService';
import type { WorkspaceService } from './workspaceService';
import type { ProcessService } from './processService';
import type { BrowserService } from './browserService';
import type { ComputerManager } from '../computer/manager';
import { ApiError } from '../config';

const sessionSchema = z.object({
  id: z.string(),
  status: z.enum(['running', 'exited', 'killed', 'failed']),
  output: z.string().optional(),
});
export class ChatOutputService {
  private pending = new Map<string, Promise<ChatServerOutput[]>>();
  constructor(
    private repository: ChatOutputRepository,
    private conversations: ConversationService,
    private workspaces: WorkspaceService,
    private processes: ProcessService,
    private computers: ComputerManager,
    private browsers: BrowserService,
  ) {}
  list(conversationId: string) {
    this.conversations.require(conversationId);
    const existing = this.pending.get(conversationId);
    if (existing) return existing;
    const task = this.load(conversationId).finally(() => this.pending.delete(conversationId));
    this.pending.set(conversationId, task);
    return task;
  }
  private async load(conversationId: string): Promise<ChatServerOutput[]> {
    const conversation = this.conversations.require(conversationId);
    const workspace = this.workspaces.require(conversation.workspaceId);
    const statuses = new Map<string, ChatServerOutput['status']>();
    const refs = new Map<string, { owner: RuntimeOwner; messageId: string; urls: string[] }>();
    for (const source of this.repository.sources(conversationId)) {
      for (const activity of source.activities) {
        if (activity.tool !== 'terminal' || activity.status !== 'complete') continue;
        // Read older saved activity too, before structured session references existed.
        let legacy: z.infer<typeof sessionSchema> | undefined;
        try {
          legacy = sessionSchema.parse(JSON.parse(activity.summary));
        } catch {
          /* Truncated preview. */
        }
        const sessionId = activity.processSessionId || legacy?.id;
        if (!sessionId) continue;
        const prior = refs.get(sessionId);
        refs.set(sessionId, {
          owner: { workspaceId: workspace.id, botId: source.botId, conversationId },
          messageId: prior?.messageId || source.messageId,
          urls: [
            ...new Set([
              ...(prior?.urls || []),
              ...(activity.serverUrls || []).flatMap((value) => localServerUrl(value) || []),
              ...serverUrls(legacy?.output || ''),
            ]),
          ],
        });
      }
    }
    const guestReady =
      workspace.computer === 'qemu' && this.computers.status(workspace).state === 'running';
    await Promise.all(
      [...refs].map(async ([sessionId, ref]) => {
        let urls = ref.urls;
        try {
          const value =
            workspace.computer === 'qemu'
              ? guestReady
                ? await this.computers
                    .guest(workspace)
                    .request(
                      'process',
                      { action: 'poll', sessionId },
                      ref.owner,
                      AbortSignal.timeout(2500),
                    )
                : undefined
              : this.processes.read(ref.owner, sessionId);
          const session = sessionSchema.parse(value);
          statuses.set(sessionId, session.status);
          urls = [...new Set([...urls, ...serverUrls(session.output || '')])];
        } catch {
          statuses.set(sessionId, 'unavailable');
        }
        for (const url of urls)
          this.repository.save(conversationId, {
            botId: ref.owner.botId,
            messageId: ref.messageId,
            sessionId,
            url,
          });
      }),
    );
    return this.repository.list(conversationId).map((row) => ({
      ...row,
      status: statuses.get(row.sessionId) || 'unavailable',
      computer: workspace.computer === 'qemu' ? 'qemu' : 'local',
    }));
  }
  async open(conversationId: string, outputId: string) {
    const conversation = this.conversations.require(conversationId);
    const workspace = this.workspaces.require(conversation.workspaceId);
    const row = this.repository.find(conversationId, outputId);
    if (!row) throw new ApiError(404, 'Output not found in this conversation.');
    const owner = { workspaceId: workspace.id, botId: row.botId, conversationId };
    const input = {
      action: 'open' as const,
      url: row.url,
      target: workspace.computer === 'qemu' ? ('chrome' as const) : ('mukai' as const),
    };
    if (workspace.computer === 'qemu') {
      if (this.computers.status(workspace).state !== 'running')
        throw new ApiError(409, 'Start the workspace computer to open this output.');
      await this.computers
        .guest(workspace)
        .request('browser', input, owner, AbortSignal.timeout(15000));
      return { guest: true };
    }
    const result = await this.browsers.execute(owner, input, AbortSignal.timeout(15000));
    if (!result || typeof result !== 'object' || !('tab' in result))
      throw new ApiError(500, 'Browser did not return a tab.');
    return { guest: false, tab: result.tab as BrowserSession };
  }
}
