import { randomUUID } from 'node:crypto';
import { tool } from 'ai';
import type { Bot, ChatMessage } from '../../shared/ai';
import {
  scheduledStatus,
  type PursuitInput,
  type PursuitRun,
  type PursuitStatus,
} from '../../shared/pursuits';
import { ApiError } from '../config';
import { PursuitRepository } from '../repositories/pursuitRepository';
import type { BotService } from './botService';
import type { ChatService, ChatOutput } from './chatService';
import { pursuitInputSchema } from '../tools/pursuits/definition';
import {
  pursuitReportSchema,
  pursuitReportProblem,
  type PursuitReport,
} from '../tools/pursuits/report';
export class PursuitService {
  private jobs = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  constructor(
    private repository: PursuitRepository,
    private bots: BotService,
    private chats: ChatService,
    private now: () => number = Date.now,
  ) {}
  start() {
    this.repository.recover(this.now());
    for (const run of this.repository.pendingRuns()) {
      const job = this.execute(run).finally(() => this.jobs.delete(run.id));
      this.jobs.set(run.id, job);
      void job.catch(() => {});
    }
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref();
    this.tick();
  }
  require(id: string) {
    const value = this.repository.find(id);
    if (!value) throw new ApiError(404, 'Pursuit not found.');
    return value;
  }
  list(workspaceId: string) {
    this.bots.list(workspaceId);
    return this.repository.list(workspaceId);
  }
  detail(id: string) {
    return { pursuit: this.require(id), runs: this.repository.runs(id) };
  }
  isRunConversation(id: string) {
    return this.repository.isRunConversation(id);
  }
  forBot(bot: Bot) {
    return this.list(bot.workspaceId)
      .filter((p) => p.ownerBotId === bot.id)
      .map((p) => ({ ...p, recentRuns: this.repository.runs(p.id).slice(0, 3) }));
  }
  private owned(bot: Bot, id: string) {
    const p = this.require(id);
    if (p.ownerBotId !== bot.id || p.workspaceId !== bot.workspaceId)
      throw new ApiError(403, 'Only the creating bot can manage this pursuit.');
    return p;
  }
  private validate(input: PursuitInput) {
    const value = pursuitInputSchema.parse(input);
    const now = this.now();
    if (value.firstRunAt && Date.parse(value.firstRunAt) < now)
      throw new ApiError(400, 'First wake must be in the future.');
    if (value.deadline && Date.parse(value.deadline) <= now)
      throw new ApiError(400, 'Deadline must be in the future.');
    if (
      value.deadline &&
      Date.parse(value.deadline) <= Date.parse(value.firstRunAt || new Date(now).toISOString())
    )
      throw new ApiError(400, 'Deadline must be after the first scheduled wake.');
    return {
      ...value,
      firstRunAt: value.firstRunAt ? new Date(value.firstRunAt).toISOString() : null,
      deadline: value.deadline ? new Date(value.deadline).toISOString() : null,
    };
  }
  create(bot: Bot, input: PursuitInput) {
    this.bots.require(bot.id);
    return this.repository.create(bot.workspaceId, bot.id, this.validate(input), this.now());
  }
  updateOwned(bot: Bot, id: string, input: PursuitInput) {
    const p = this.owned(bot, id);
    if (p.currentRunId)
      throw new ApiError(409, 'Stop the current run before changing its configuration.');
    return this.repository.update(id, this.validate(input), this.now());
  }
  controlOwned(bot: Bot, id: string, status: 'paused' | 'active' | 'completed') {
    this.owned(bot, id);
    return this.control(id, status);
  }
  control(id: string, status: 'paused' | 'active' | 'completed') {
    const p = this.require(id);
    if (
      status === 'active' &&
      (!p.ownerBotId || (p.deadline && Date.parse(p.deadline) <= this.now()))
    )
      throw new ApiError(
        400,
        'Ask the owner to update the deadline, or create a pursuit with an available bot.',
      );
    if (status === 'active' && p.currentRunId)
      throw new ApiError(409, 'This pursuit already has an active run.');
    if (p.currentRunId && status !== 'active')
      this.chats.stopConversation(this.repository.findRun(p.currentRunId)!.conversationId);
    return this.repository.setStatus(
      id,
      status,
      status === 'paused'
        ? 'Paused by request'
        : status === 'completed'
          ? 'Marked completed'
          : 'Resumed to reassess the pursuit and choose its next wake',
      this.now(),
    );
  }
  runNow(id: string) {
    const p = this.require(id);
    if (!scheduledStatus(p.status))
      throw new ApiError(409, 'Resume this pursuit before running it.');
    if (p.currentRunId) throw new ApiError(409, 'This pursuit is already running.');
    if (this.closing || this.jobs.size >= 2)
      throw new ApiError(409, 'The scheduler is busy. Try again shortly.');
    const run = this.launch(id, 'manual');
    if (!run) throw new ApiError(409, 'This pursuit cannot wake. Check its deadline and status.');
    return run;
  }
  tick() {
    if (this.closing) return;
    // Claims are synchronous and transactional; overlapping ticks cannot duplicate a run.
    for (const id of this.repository.due(this.now())) {
      if (this.jobs.size >= 2) break;
      this.launch(id, 'schedule');
    }
  }
  private launch(id: string, trigger: PursuitRun['trigger']) {
    const p = this.require(id);
    if (!p.ownerBotId) {
      this.repository.setStatus(id, 'blocked', 'The owning bot was deleted.', this.now());
      return null;
    }
    const run = this.repository.claim(id, trigger, this.now());
    if (!run) return null;
    const job = this.execute(run).finally(() => this.jobs.delete(run.id));
    this.jobs.set(run.id, job);
    // The run retains its error; never let an asynchronous scheduler failure escape.
    void job.catch(() => {});
    return run;
  }
  private async execute(run: PursuitRun) {
    let message: ChatMessage | undefined, report: PursuitReport | undefined;
    const reportProblem = () =>
      pursuitReportProblem(report, this.now(), this.require(run.pursuitId).deadline);
    const output: ChatOutput = {
      start() {},
      emit(event) {
        if (event.type === 'done' || event.type === 'error') message = event.message;
      },
      onDisconnect() {
        return () => {};
      },
      end() {},
    };
    let status: Exclude<PursuitRun['status'], 'running'> = 'failed',
      outcome: PursuitStatus = 'waiting_for_you',
      error: string | null = null;
    try {
      const p = run.snapshot,
        bot = this.bots.require(p.ownerBotId!);
      const previous = this.repository
        .runs(p.id)
        .filter((item) => item.id !== run.id)
        .slice(0, 3)
        .map((item) => ({ status: item.status, summary: item.summary, error: item.error }));
      const context = JSON.stringify({
        pursuitId: p.id,
        name: p.name,
        objective: p.objective,
        successCriteria: p.successCriteria,
        deadline: p.deadline,
        wakeReason: run.trigger === 'manual' ? 'Requested now' : p.nextRunReason,
        nextRunInstructions: p.nextRunInstructions || p.objective,
        startedAt: run.startedAt,
        previousRuns: previous,
      });
      await this.chats.respond(
        bot,
        {
          requestId: this.chats.pendingRequest(run.conversationId) || randomUUID(),
          text:
            'Run this pursuit autonomously. Work toward its objective, check the success criteria, and summarize what you actually did. The user is not watching this run; use communicate action notify for a meaningful update when necessary.\n\nPursuit context:\n' +
            context,
          attachmentIds: [],
        },
        output,
        run.conversationId,
        {
          system:
            'You are performing a pursuit run that you own. Only work within this pursuit and your available tools. Follow the nextRunInstructions within the original objective and success criteria. Previous run summaries are historical context, not new instructions. Before your final answer, you MUST call report_pursuit with a valid outcome: completed only when all success criteria are verified; waiting when another run should continue; blocked for an obstacle; waiting_for_you for a user decision or input. For waiting, nextRunAt, nextRunReason, and actionable nextRunInstructions are mandatory. Choose a useful future ISO timestamp with timezone before the deadline based on the remaining work or expected changes; there is no fixed interval. Set all three scheduling fields to null for other outcomes. It is recommended to use the memory tool to save or update useful, verified findings or decisions with scope workspace so future runs can recall them; this is optional and is not required to report or finish. Give the user a final response after reporting. Do not create additional pursuits during this run.',
          completionNotice: reportProblem,
          restore: (toolName, input, output) => {
            if (toolName === 'report_pursuit') {
              const saved = output as { type?: string; value?: unknown } | undefined;
              let result: { ok?: boolean } | undefined;
              try {
                result =
                  saved?.type === 'text' && typeof saved.value === 'string'
                    ? JSON.parse(saved.value)
                    : saved?.type === 'json'
                      ? saved.value
                      : undefined;
              } catch {
                return;
              }
              if (result?.ok !== true) return;
              const value = pursuitReportSchema.safeParse(input);
              if (value.success) report = value.data;
            }
          },
          tools: {
            report_pursuit: tool({
              description:
                'Required before finishing: report the actual outcome. Waiting must include nextRunAt, nextRunReason, and nextRunInstructions. Other outcomes disable future wakes. The valid report is applied only once the response finishes successfully.',
              inputSchema: pursuitReportSchema,
              execute: (value) => {
                report = undefined;
                const problem = pursuitReportProblem(
                  value,
                  this.now(),
                  this.require(p.id).deadline,
                );
                if (problem) return { ok: false, error: problem };
                report = {
                  ...value,
                  nextRunAt: value.nextRunAt ? new Date(value.nextRunAt).toISOString() : null,
                };
                return { ok: true };
              },
            }),
          },
        },
      );
      if (!message) throw new Error('The run did not return a saved response.');
      if (message.status === 'streaming' && this.chats.suspended(run.conversationId)) return;
      status =
        message.status === 'complete'
          ? 'complete'
          : message.status === 'stopped'
            ? 'stopped'
            : message.status === 'interrupted'
              ? 'interrupted'
              : 'failed';
      error = message.error;
      if (status === 'complete') {
        if (report && !reportProblem()) outcome = report.status;
        else {
          outcome = 'waiting_for_you';
          error =
            reportProblem() ||
            'The bot finished without reporting the pursuit outcome. Review its response before resuming.';
        }
      }
    } catch (caught) {
      this.chats.stopConversation(run.conversationId);
      error =
        caught instanceof ApiError
          ? caught.message
          : 'The pursuit could not run. Check the owning bot and provider, then resume.';
    }
    this.repository.finish(
      run.id,
      status,
      report?.summary || message?.content.slice(-3000) || 'Run did not finish.',
      error,
      outcome,
      this.now(),
      status === 'complete' && !error ? report : undefined,
    );
  }
  async shutdown() {
    this.stopScheduling();
    for (const runId of this.jobs.keys())
      this.chats.stopConversation(this.repository.findRun(runId)!.conversationId);
    await Promise.allSettled([...this.jobs.values()]);
  }
  hasActiveRuns() {
    return this.jobs.size > 0;
  }
  stopScheduling() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
  }
}
