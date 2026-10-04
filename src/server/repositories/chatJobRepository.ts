import type { ModelMessage } from 'ai';
import type { ChatActivity, ContextUsage, ResponsePart } from '../../shared/ai';
import type { Database } from '../db/database';

export interface ChatCheckpoint {
  messages: ModelMessage[];
  usage: ContextUsage;
  steps: number;
  response?: {
    content: string;
    reasoning: string;
    parts: ResponsePart[];
    activity: ChatActivity[];
  };
}
export class ChatCheckpointError extends Error {}

export interface ApprovalStepCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  batchId: string;
  state: 'pending' | 'running' | 'resolved';
  output?: Extract<
    Extract<ModelMessage, { role: 'tool' }>['content'][number],
    { type: 'tool-result' }
  >['output'];
}

// Checkpoints contain model context, never provider credentials or request headers.
export class ChatJobRepository {
  constructor(private database: Database) {}
  approvalStep(id: string): ApprovalStepCall[] {
    const row = this.database.get(
      'SELECT approval_step_json FROM chat_jobs WHERE message_id=?',
      id,
    );
    return row?.approval_step_json ? JSON.parse(String(row.approval_step_json)) : [];
  }
  private saveApprovalStep(id: string, calls: ApprovalStepCall[]) {
    this.database.run(
      'UPDATE chat_jobs SET approval_step_json=? WHERE message_id=?',
      JSON.stringify(calls),
      id,
    );
  }
  approvalCall(id: string, call: ApprovalStepCall) {
    const calls = this.approvalStep(id);
    if (!calls.some((item) => item.toolCallId === call.toolCallId))
      this.saveApprovalStep(id, [...calls, call]);
  }
  approvalResult(id: string, toolCallId: string, output: ApprovalStepCall['output']) {
    this.saveApprovalStep(
      id,
      this.approvalStep(id).map((call) =>
        call.toolCallId === toolCallId ? { ...call, state: 'resolved', output } : call,
      ),
    );
  }
  completedWork(id: string, activity: ChatActivity[]) {
    const row = this.database.get('SELECT checkpoint_json FROM chat_jobs WHERE message_id=?', id);
    if (!row) return [];
    try {
      const checkpoint = JSON.parse(String(row.checkpoint_json)) as ChatCheckpoint;
      const ids = new Set(activity.map((item) => item.id));
      const results = new Map<string, unknown>();
      for (const message of checkpoint.messages) {
        if (message.role !== 'tool') continue;
        for (const part of message.content) {
          if (part.type === 'tool-result' && ids.has(part.toolCallId))
            results.set(part.toolCallId, part.output);
        }
      }
      const work = checkpoint.messages.flatMap((message) =>
        message.role === 'assistant' && Array.isArray(message.content)
          ? message.content.flatMap((part) =>
              part.type === 'tool-call' && ids.has(part.toolCallId) && results.has(part.toolCallId)
                ? [{ tool: part.toolName, input: part.input, output: results.get(part.toolCallId) }]
                : [],
            )
          : [],
      );
      return work;
    } catch {
      // Visible progress remains available if an old checkpoint is damaged.
      return [];
    }
  }
  read(id: string, fingerprint: string, recoverApproval = false): ChatCheckpoint | undefined {
    const row = this.database.get('SELECT * FROM chat_jobs WHERE message_id=?', id);
    if (
      !row ||
      row.fingerprint !== fingerprint ||
      (row.in_flight && !(recoverApproval && row.approval_step_json))
    )
      return;
    try {
      const value = JSON.parse(String(row.checkpoint_json)) as ChatCheckpoint;
      if (Array.isArray(value.messages) && value.usage && Number.isFinite(value.steps))
        return value;
    } catch {
      /* A damaged checkpoint cannot safely resume. */
    }
  }
  save(id: string, fingerprint: string, value: ChatCheckpoint) {
    const json = JSON.stringify(value, (_key, item: unknown) =>
      item instanceof Uint8Array ? Buffer.from(item).toString('base64') : item,
    );
    if (Buffer.byteLength(json) > 32 * 1024 * 1024)
      throw new ChatCheckpointError(
        'The working context is too large to checkpoint safely. Completed work is saved; use a smaller model context or request.',
      );
    this.database.run(
      `INSERT INTO chat_jobs(message_id,checkpoint_json,fingerprint,in_flight,updated_at) VALUES(?,?,?,0,?)
       ON CONFLICT(message_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json,fingerprint=excluded.fingerprint,in_flight=0,updated_at=excluded.updated_at,approval_step_json=NULL`,
      id,
      json,
      fingerprint,
      new Date().toISOString(),
    );
  }
  beforeTool(id: string, toolCallId?: string) {
    // Mark uncertainty BEFORE a side effect. A crash cannot cause an automatic replay.
    this.database.run('UPDATE chat_jobs SET in_flight=1 WHERE message_id=?', id);
    if (toolCallId)
      this.saveApprovalStep(
        id,
        this.approvalStep(id).map((call) =>
          call.toolCallId === toolCallId ? { ...call, state: 'running' } : call,
        ),
      );
  }
  accounting(id: string, usage: ContextUsage) {
    const row = this.database.get('SELECT checkpoint_json FROM chat_jobs WHERE message_id=?', id);
    if (!row) return;
    const checkpoint = JSON.parse(String(row.checkpoint_json)) as ChatCheckpoint;
    // Updating usage must never clear an uncertain operation or advance context.
    this.database.run(
      'UPDATE chat_jobs SET checkpoint_json=?,updated_at=? WHERE message_id=?',
      JSON.stringify({ ...checkpoint, usage }),
      new Date().toISOString(),
      id,
    );
  }
  remove(id: string) {
    this.database.run('DELETE FROM chat_jobs WHERE message_id=?', id);
  }
  context(conversationId: string, botId: string) {
    const row = this.database.get(
      'SELECT * FROM conversation_contexts WHERE conversation_id=? AND bot_id=?',
      conversationId,
      botId,
    );
    return row
      ? { summary: String(row.summary), throughSequence: Number(row.through_sequence) }
      : undefined;
  }
  saveContext(conversationId: string, botId: string, summary: string, throughSequence: number) {
    this.database.run(
      `INSERT INTO conversation_contexts VALUES(?,?,?,?) ON CONFLICT(conversation_id,bot_id)
       DO UPDATE SET summary=excluded.summary,through_sequence=excluded.through_sequence`,
      conversationId,
      botId,
      summary,
      throughSequence,
    );
  }
}
