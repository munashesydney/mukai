import { createHash } from 'node:crypto';
import type { LanguageModelMiddleware } from 'ai';
import { isBotRuntimeContext } from '../../shared/botSystemPrompt';
import type { TrajectoryDetail, TrajectoryRecord } from '../../shared/trajectory';
import type { TrajectoryRepository } from '../repositories/trajectoryRepository';
import type { DiagnosticService } from './diagnosticService';
import { unsuccessfulToolResult } from './toolFeedback';
import { limitResultText, resultPreview } from './toolResultPolicy';

type StreamOptions = Parameters<NonNullable<LanguageModelMiddleware['wrapStream']>>[0];
type ModelStream = Awaited<ReturnType<StreamOptions['doStream']>>['stream'];
type StreamPart = ModelStream extends ReadableStream<infer Part> ? Part : never;
type FunctionTool = Extract<
  NonNullable<StreamOptions['params']['tools']>[number],
  { type: 'function' }
>;
type Entry = {
  id?: number;
  summary: Omit<TrajectoryRecord, 'id' | 'messageId'>;
  detail: TrajectoryDetail;
  modelOutput?: { output: string; reasoning: string };
  linkedParts?: Set<string>;
};

const shortened = '[Trajectory preview shortened.]';
const detailLimit = 16_000;
const sensitiveKey =
  /^(?:(?:x[_-]?)?api[_-]?key|(?:proxy-)?authorization|cookie|set-cookie|password|secret|client[_-]?secret|credentials?|private[_-]?key|(?:(?:access|refresh|session|auth)[_-]?)?token)$/i;

/** Records dispatches independently of the checkpoint used to resume a response. */
export class ChatTrajectory {
  private current?: Entry;
  private running = new Set<Entry>();
  private calls = new Map<string, Entry>();
  private toolSchemas = new Map<string, FunctionTool>();
  private reportedWriteFailure = false;

  constructor(
    private repository: TrajectoryRepository,
    private diagnostics: DiagnosticService,
    private messageId: string,
    private conversationId: string,
  ) {}

  private text(value: string, limit = detailLimit) {
    const bounded = limitResultText(value, limit + 4096, shortened);
    return limitResultText(
      this.diagnostics
        .redactSensitiveText(bounded)
        .replace(
          /data:[\w.+/-]+(?:;[\w.+-]+)*,[^\s"'<>]+|[A-Za-z0-9+/]{512,}={0,2}/g,
          '[Encoded data omitted]',
        ),
      limit,
      shortened,
    );
  }

  private value(value: unknown) {
    if (typeof value === 'string') return this.text(value);
    return resultPreview(value, detailLimit, shortened, {
      redactKey: (key) => sensitiveKey.test(key),
      text: (text) => this.text(text),
    });
  }

  private write(entry: Entry) {
    try {
      if (entry.id === undefined)
        entry.id = this.repository.start(this.messageId, entry.summary, entry.detail);
      else this.repository.update(entry.id, entry.summary, entry.detail);
    } catch {
      if (this.reportedWriteFailure) return;
      this.reportedWriteFailure = true;
      this.diagnostics.info('chat.trajectory_write_failed', 'Could not save the trajectory.', {
        messageId: this.messageId,
        conversationId: this.conversationId,
      });
    }
  }

  private start(summary: Entry['summary'], detail: TrajectoryDetail) {
    const entry: Entry = { summary, detail };
    this.running.add(entry);
    this.write(entry);
    return entry;
  }

  private settle(entry: Entry, status: Exclude<TrajectoryRecord['status'], 'running'>) {
    if (!this.running.delete(entry)) return;
    entry.summary.status = status;
    entry.summary.finishedAt = Date.now();
    this.write(entry);
  }

  interrupt() {
    for (const entry of this.running) {
      if (entry.summary.kind === 'model') this.finishModel(entry, 'interrupted');
      else this.settle(entry, 'interrupted');
    }
  }

  linkPart(id: string) {
    this.current?.linkedParts?.add(id);
  }

  flushParts() {
    const entry = this.current;
    if (!entry?.linkedParts?.size) return;
    if (entry.linkedParts.size === entry.summary.partIds?.length) return;
    entry.summary.partIds = [...entry.linkedParts];
    this.write(entry);
  }

  private call(name: string, callId: string, input?: unknown, parentCallId?: string) {
    let entry = this.calls.get(callId);
    if (!entry) {
      const definition = this.toolSchemas.get(name);
      entry = this.start(
        {
          kind: 'tool',
          title: this.text(name, 200),
          status: 'running',
          startedAt: Date.now(),
          stepId: this.current?.id,
          callId,
          parentCallId,
        },
        {
          input: input === undefined ? undefined : this.value(input),
          schema: definition && {
            description: definition.description && this.text(definition.description),
            parameters: this.value(definition.inputSchema),
          },
        },
      );
      this.calls.set(callId, entry);
    }
    return entry;
  }

  private output(entry: Entry, output: unknown) {
    entry.detail.output = this.value(output);
    entry.summary.preview = entry.detail.output.slice(0, 240);
  }

  async runTool<T>(
    name: string,
    callId: string,
    input: unknown,
    signal: AbortSignal | undefined,
    run: () => T | PromiseLike<T>,
    parentCallId?: string,
  ) {
    const entry = this.call(name, callId, input, parentCallId);
    try {
      const result = await run();
      // Root calls get their payload after the model-facing result policy runs.
      if (parentCallId) this.output(entry, result);
      this.settle(
        entry,
        signal?.aborted ? 'interrupted' : unsuccessfulToolResult(result) ? 'failed' : 'complete',
      );
      return result;
    } catch (error) {
      entry.detail.error = 'The tool did not complete. See the response activity for details.';
      this.settle(entry, signal?.aborted ? 'interrupted' : 'failed');
      throw error;
    }
  }

  toolOutput(callId: string, output: unknown) {
    const entry = this.calls.get(callId);
    if (!entry) return;
    this.output(entry, output);
    this.write(entry);
  }

  toolError(name: string, callId: string) {
    const entry = this.call(name, callId);
    entry.detail.error = 'The tool could not run. Check the call input and response activity.';
    if (entry.summary.status === 'complete') {
      entry.summary.status = 'failed';
      this.write(entry);
    } else this.settle(entry, 'failed');
  }

  async stream({ doStream, params, model }: StreamOptions) {
    const system = this.text(
      params.prompt
        .flatMap((message) => (message.role === 'system' ? [message.content] : []))
        .join('\n\n'),
      48_000,
    );
    const contexts = params.prompt.flatMap((message) =>
      message.role === 'user'
        ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
        : [],
    );
    const runtime = contexts.filter(isBotRuntimeContext).at(-1);
    const memory = contexts
      .filter(
        (text) =>
          text.startsWith('Retrieved memory reference data.') ||
          text.startsWith('Working memory from earlier activity'),
      )
      .slice(-2);
    const context = [...memory, ...(runtime ? [runtime] : [])].map((text) => this.text(text));
    const entry = this.start(
      {
        kind: 'model',
        title: this.text(model.modelId, 200),
        status: 'running',
        startedAt: Date.now(),
        systemKey: system ? createHash('sha256').update(system).digest('hex') : undefined,
        systemPreview: system.slice(0, 240) || undefined,
        contextPreviews: context.map((text) => text.slice(0, 240)),
      },
      {
        system: system || undefined,
        context,
        input: this.value({
          provider: model.provider,
          model: model.modelId,
          reasoning: params.reasoning,
          maxOutputTokens: params.maxOutputTokens,
          toolChoice: params.toolChoice,
          tools: params.tools?.map((tool) => tool.name),
        }),
      },
    );
    const modelOutput = { output: '', reasoning: '' };
    entry.modelOutput = modelOutput;
    entry.linkedParts = new Set();
    this.current = entry;
    this.calls.clear();
    this.toolSchemas.clear();
    for (const tool of params.tools ?? []) {
      if (tool.type === 'function') this.toolSchemas.set(tool.name, tool);
    }
    const aborted = () => params.abortSignal?.aborted;
    const fail = (error: unknown) => {
      const status =
        error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
      entry.detail.error =
        typeof status === 'number'
          ? `The provider request failed (HTTP ${status}).`
          : 'The provider stream ended with an error.';
      this.settle(entry, aborted() ? 'interrupted' : 'failed');
    };
    try {
      const result = await doStream();
      const reader = result.stream.getReader();
      const stream = new ReadableStream<StreamPart>({
        pull: async (controller) => {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              if (this.running.has(entry)) {
                this.cleanOutput(entry);
                fail(undefined);
              }
              controller.close();
              return;
            }
            const part = chunk.value;
            const firstToken =
              ((part.type === 'text-delta' ||
                part.type === 'reasoning-delta' ||
                part.type === 'tool-input-delta') &&
                part.delta.length > 0) ||
              part.type === 'tool-call';
            if (firstToken && entry.summary.firstTokenAt === undefined) {
              entry.summary.firstTokenAt = Date.now();
              this.write(entry);
            }
            if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
              const field = part.type === 'text-delta' ? 'output' : 'reasoning';
              const previous = modelOutput[field];
              if (previous.length < detailLimit + 4097)
                modelOutput[field] = (previous + part.delta).slice(0, detailLimit + 4097);
            } else if (part.type === 'tool-call') {
              let input: unknown = '[Invalid or oversized tool input omitted.]';
              if (part.input.length <= 64_000) {
                try {
                  input = JSON.parse(part.input);
                } catch {
                  /* Invalid JSON can contain arbitrary secrets outside field boundaries. */
                }
              }
              this.call(part.toolName, part.toolCallId, input);
            } else if (part.type === 'tool-result' && !part.preliminary) {
              const tool = this.call(part.toolName, part.toolCallId);
              this.output(tool, part.result);
              this.settle(tool, part.isError ? 'failed' : 'complete');
            } else if (part.type === 'finish') {
              entry.summary.usage = {
                input: part.usage.inputTokens.total,
                output: part.usage.outputTokens.total,
                cached: part.usage.inputTokens.cacheRead,
                reasoning: part.usage.outputTokens.reasoning,
              };
              this.finishModel(
                entry,
                part.finishReason.unified === 'error' ? 'failed' : 'complete',
              );
            } else if (part.type === 'error') {
              this.cleanOutput(entry);
              fail(part.error);
            }
            controller.enqueue(part);
          } catch (error) {
            this.cleanOutput(entry);
            fail(error);
            controller.error(error);
          }
        },
        cancel: (reason) => {
          this.finishModel(entry, 'interrupted');
          return reader.cancel(reason);
        },
      });
      return { ...result, stream };
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  private cleanOutput(entry: Entry) {
    if (entry.modelOutput?.output) entry.detail.output = this.text(entry.modelOutput.output);
    if (entry.modelOutput?.reasoning)
      entry.detail.reasoning = this.text(entry.modelOutput.reasoning);
    entry.summary.preview = (entry.detail.output || entry.detail.reasoning)?.slice(0, 240);
  }

  private finishModel(entry: Entry, status: 'complete' | 'failed' | 'interrupted') {
    this.cleanOutput(entry);
    entry.modelOutput = undefined;
    this.settle(entry, status);
  }
}
