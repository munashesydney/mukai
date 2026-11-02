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
import { terminalSnapshotSchema, type TerminalSnapshot } from '../../shared/terminal';
import { processActivitySchema, type ProcessActivity } from '../../shared/processActivity';

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
  async terminal(conversationId: string, sessionId: string): Promise<TerminalSnapshot> {
    const conversation = this.conversations.require(conversationId);
    const workspace = this.workspaces.require(conversation.workspaceId);
    let reference:
      | { snapshot?: TerminalSnapshot; botId: string; messageId: string; activityId: string }
      | undefined;
    for (const source of this.repository.sources(conversationId)) {
      for (const activity of source.activities) {
        if (activity.tool !== 'terminal') continue;
        let saved = terminalSnapshotSchema.safeParse(activity.terminal);
        if (!saved.success) {
          try {
            saved = terminalSnapshotSchema.safeParse(JSON.parse(activity.summary));
          } catch {
            /* Older previews can be truncated. */
          }
        }
        if ((activity.processSessionId || (saved.success ? saved.data.id : '')) !== sessionId)
          continue;
        reference = {
          snapshot: saved.success ? saved.data : reference?.snapshot,
          botId: source.botId,
          messageId: source.messageId,
          activityId: activity.id,
        };
      }
    }
    if (!reference) throw new ApiError(404, 'Terminal session not found in this conversation.');
    try {
      const owner = { workspaceId: workspace.id, botId: reference.botId, conversationId };
      let result: unknown;
      if (workspace.computer === 'qemu') {
        if (this.computers.status(workspace).state !== 'running')
          throw new Error('Computer is stopped.');
        result = await this.computers
          .guest(workspace)
          .request('process', { action: 'poll', sessionId }, owner, AbortSignal.timeout(2500));
      } else result = this.processes.read(owner, sessionId);
      const snapshot = terminalSnapshotSchema.parse(result);
      if (snapshot.status !== 'running')
        this.repository.saveTerminal(
          conversationId,
          reference.messageId,
          reference.activityId,
          snapshot,
        );
      return snapshot;
    } catch {
      if (reference.snapshot) return { ...reference.snapshot, unavailable: true };
      throw new ApiError(404, 'Terminal session is no longer available.');
    }
  }
  private async load(conversationId: string): Promise<ChatServerOutput[]> {
    const conversation = this.conversations.require(conversationId);
    const workspace = this.workspaces.require(conversation.workspaceId);
    const statuses = new Map<string, ChatServerOutput['status']>();
    const refs = new Map<string, { owner: RuntimeOwner; messageId: string; urls: string[] }>();
    for (const source of this.repository.sources(conversationId)) {
      for (const activity of source.activities) {
        if (activity.tool !== 'terminal' || activity.status !== 'complete') continue;
        let saved: z.infer<typeof sessionSchema> | undefined;
        const terminal = sessionSchema.safeParse(activity.terminal);
        if (terminal.success) saved = terminal.data;
        else
          try {
            saved = sessionSchema.parse(JSON.parse(activity.summary));
          } catch {
            /* Truncated legacy preview. */
          }
        const sessionId = activity.processSessionId || saved?.id;
        if (!sessionId) continue;
        const status =
          activity.processStatus && activity.processStatus !== 'running'
            ? activity.processStatus
            : saved?.status;
        if (status) statuses.set(sessionId, status);
        const prior = refs.get(sessionId);
        refs.set(sessionId, {
          owner: { workspaceId: workspace.id, botId: source.botId, conversationId },
          messageId: prior?.messageId || source.messageId,
          urls: [
            ...new Set([
              ...(prior?.urls || []),
              ...(activity.serverUrls || []).flatMap((value) => localServerUrl(value) || []),
              ...serverUrls(saved?.output || ''),
            ]),
          ],
        });
      }
    }
    // A single compact read per owner replaces one full-output RPC per historical command.
    // Completed sessions retain their saved status and URLs, even after the runtime restarts.
    const groups = new Map<string, RuntimeOwner>();
    for (const [sessionId, ref] of refs) {
      const status = statuses.get(sessionId);
      if (!status || status === 'running') groups.set(ref.owner.botId, ref.owner);
    }
    const guestReady =
      workspace.computer === 'qemu' && this.computers.status(workspace).state === 'running';
    for (const owner of groups.values()) {
      let sessions: ProcessActivity[] = [];
      try {
        if (workspace.computer !== 'qemu') sessions = this.processes.activity(owner);
        else if (guestReady)
          sessions = processActivitySchema.parse(
            await this.computers
              .guest(workspace)
              .requestRunning(
                'process',
                { action: 'activity' },
                owner,
                AbortSignal.timeout(2500),
                undefined,
                { priority: 'background' },
              ),
          );
      } catch {
        /* A refresh must not erase saved links when the computer is busy or offline. */
      }
      const live = new Map(sessions.map((session) => [session.id, session]));
      for (const [sessionId, ref] of refs) {
        if (ref.owner.botId !== owner.botId) continue;
        const status = statuses.get(sessionId);
        if (status && status !== 'running') continue;
        const session = live.get(sessionId);
        statuses.set(sessionId, session?.status || 'unavailable');
        if (session)
          ref.urls = [
            ...new Set([
              ...ref.urls,
              ...session.serverUrls.flatMap((url) => localServerUrl(url) || []),
            ]),
          ];
      }
      this.repository.saveProcessActivity(conversationId, owner.botId, sessions);
    }
    for (const [sessionId, ref] of refs) {
      for (const url of ref.urls)
        this.repository.save(conversationId, {
          botId: ref.owner.botId,
          messageId: ref.messageId,
          sessionId,
          url,
        });
    }
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
