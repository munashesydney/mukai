import type { ModelMessage } from 'ai';
import type { ChatActivity, ContextUsage, ResponsePart } from '../../shared/ai';
import type { Database } from '../db/database';

export interface ChatCheckpoint {
  messages: ModelMessage[];
  steeringRequests?: { id: string; messageIndex: number }[];
  usage: ContextUsage;
  steps: number;
  emptyReplyRecoveries?: number;
  providerToolCallRecoveries?: number;
  response?: {
    content: string;
    reasoning: string;
    parts: ResponsePart[];
    activity: ChatActivity[];
  };
}
export class ChatCheckpointError extends Error {}

/** Only saved tool calls still waiting to be incorporated into the model context. */
export const resumableDelegationMessages = `SELECT d.parent_message_id FROM bot_delegations d
  JOIN chat_jobs j ON j.message_id=d.parent_message_id
  WHERE d.state IN ('waiting','complete') AND (
    (d.mode='fire_and_forget' AND d.delivered=0) OR EXISTS (
      SELECT 1 FROM json_each(j.approval_step_json) step
      WHERE json_extract(step.value,'$.toolCallId')=d.tool_call_id))`;

export interface DelegationResult {
  botId: string;
  conversationId: string;
  requestId: string;
  messageId?: string;
  status: 'complete' | 'failed' | 'stopped' | 'interrupted';
  response: string;
  error: string | null;
}

export interface BotDelegation {
  parentMessageId: string;
  toolCallId: string;
  callerId: string;
  targetId: string;
  conversationId: string;
  childRequestId: string;
  message: string;
  state: 'waiting' | 'complete' | 'cancelled';
  mode?: 'wait' | 'fire_and_forget';
}

export interface BackgroundDelivery {
  messageId: string;
  toolCallIds: string[];
}

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
  delegation(messageId: string, toolCallId: string): BotDelegation | undefined {
    const row = this.database.get(
      'SELECT * FROM bot_delegations WHERE parent_message_id=? AND tool_call_id=?',
      messageId,
      toolCallId,
    );
    if (!row) return;
    return {
      parentMessageId: String(row.parent_message_id),
      toolCallId: String(row.tool_call_id),
      callerId: String(row.caller_id),
      targetId: String(row.target_id),
      conversationId: String(row.conversation_id),
      childRequestId: String(row.child_request_id),
      message: String(row.message),
      state: row.state as BotDelegation['state'],
      mode: row.mode as BotDelegation['mode'],
    };
  }
  saveDelegation(value: BotDelegation) {
    this.database.run(
      'INSERT INTO bot_delegations(parent_message_id,tool_call_id,caller_id,target_id,conversation_id,child_request_id,message,state,mode) VALUES(?,?,?,?,?,?,?,?,?)',
      value.parentMessageId,
      value.toolCallId,
      value.callerId,
      value.targetId,
      value.conversationId,
      value.childRequestId,
      value.message,
      value.state,
      value.mode ?? 'wait',
    );
  }
  delegationState(messageId: string, toolCallId: string, state: BotDelegation['state']) {
    this.database.run(
      "UPDATE bot_delegations SET state=? WHERE parent_message_id=? AND tool_call_id=? AND state!='cancelled'",
      state,
      messageId,
      toolCallId,
    );
  }
  completeDelegation(messageId: string, toolCallId: string, result: DelegationResult) {
    this.database.run(
      "UPDATE bot_delegations SET state='complete',result_json=? WHERE parent_message_id=? AND tool_call_id=? AND state!='cancelled'",
      JSON.stringify(result),
      messageId,
      toolCallId,
    );
  }
  backgroundDelegations(messageId: string) {
    return this.database
      .all(
        `SELECT d.*,b.name AS bot_name,b.avatar AS bot_avatar,m.id AS reply_id,m.status AS reply_status,
        m.content AS reply_content,m.error AS reply_error
       FROM bot_delegations d JOIN bots b ON b.id=d.target_id
       LEFT JOIN messages m ON m.conversation_id=d.conversation_id AND m.request_id=d.child_request_id
         AND m.role='assistant' AND m.bot_id=d.target_id
       WHERE d.parent_message_id=? AND d.mode='fire_and_forget' AND d.delivered=0 AND d.state!='cancelled'`,
        messageId,
      )
      .map((row) => ({
        toolCallId: String(row.tool_call_id),
        botId: String(row.target_id),
        botName: String(row.bot_name),
        avatar: String(row.bot_avatar),
        conversationId: String(row.conversation_id),
        requestId: String(row.child_request_id),
        message: String(row.message),
        result: row.result_json
          ? (JSON.parse(String(row.result_json)) as DelegationResult)
          : row.reply_status && row.reply_status !== 'streaming'
            ? {
                botId: String(row.target_id),
                conversationId: String(row.conversation_id),
                requestId: String(row.child_request_id),
                messageId: String(row.reply_id),
                status: row.reply_status as DelegationResult['status'],
                response: String(row.reply_content || '').slice(-12000),
                error: row.reply_error ? String(row.reply_error) : null,
              }
            : undefined,
      }));
  }
  /**
   * Ready background results still attached to a parent response that ended before it could
   * collect them. A stop cancels its chain and an 'interrupted' parent keeps its own resume path,
   * which collects results under the parent's own message id, so in practice these are parents
   * whose response failed mid-flight. The wider status set only makes sure a parent that somehow
   * ended with a row still waiting and uncancelled cannot lose it. The next response from the
   * same bot in the same conversation delivers them.
   */
  orphanedBackgroundResults(conversationId: string, botId: string, messageId: string) {
    const parents = this.database
      .all(
        `SELECT p.id FROM messages p WHERE p.conversation_id=? AND p.bot_id=? AND p.id!=?
       AND p.status IN ('complete','failed','stopped')
       AND EXISTS (SELECT 1 FROM bot_delegations d WHERE d.parent_message_id=p.id
         AND d.mode='fire_and_forget' AND d.delivered=0 AND d.state!='cancelled')
       ORDER BY p.sequence`,
        conversationId,
        botId,
        messageId,
      )
      .map((row) => String(row.id));
    return parents.flatMap((parentMessageId) =>
      this.backgroundDelegations(parentMessageId)
        .filter((child) => child.result)
        .map((child) => ({ ...child, parentMessageId })),
    );
  }
  consumeBackground(deliveries: BackgroundDelivery[], save: () => void) {
    this.database.transaction(() => {
      save();
      for (const delivery of deliveries)
        for (const toolCallId of delivery.toolCallIds)
          this.database.run(
            'UPDATE bot_delegations SET delivered=1 WHERE parent_message_id=? AND tool_call_id=?',
            delivery.messageId,
            toolCallId,
          );
    });
  }
  cancelDelegations(messageId: string) {
    const children = this.database
      .all(
        "SELECT conversation_id,child_request_id FROM bot_delegations WHERE parent_message_id=? AND state='waiting' AND mode='wait'",
        messageId,
      )
      .map((row) => ({
        conversationId: String(row.conversation_id),
        requestId: String(row.child_request_id),
      }));
    this.database.run(
      "UPDATE bot_delegations SET state='cancelled' WHERE parent_message_id=? AND ((mode='wait' AND state='waiting') OR (mode='fire_and_forget' AND delivered=0))",
      messageId,
    );
    return children;
  }
  resumableDelegation(messageId: string, toolCallId?: string): boolean {
    if (!toolCallId && this.backgroundDelegations(messageId).length) return true;
    const calls = this.approvalStep(messageId);
    if (!toolCallId)
      return calls.some((call) => this.resumableDelegation(messageId, call.toolCallId));
    if (!calls.some((call) => call.toolCallId === toolCallId)) return false;
    return Boolean(
      this.database.get(
        "SELECT 1 FROM bot_delegations WHERE parent_message_id=? AND state IN ('waiting','complete') AND tool_call_id=?",
        messageId,
        toolCallId,
      ),
    );
  }
  delegatedRequest(conversationId: string, requestId: string) {
    return Boolean(
      this.database.get(
        "SELECT 1 FROM bot_delegations WHERE conversation_id=? AND child_request_id=? AND state='waiting'",
        conversationId,
        requestId,
      ),
    );
  }
  delegationRequest(conversationId: string) {
    const row = this.database.get(
      `SELECT request_id FROM messages WHERE conversation_id=?
      AND status IN ('streaming','interrupted') AND id IN (${resumableDelegationMessages})
      ORDER BY sequence DESC LIMIT 1`,
      conversationId,
    );
    return row ? String(row.request_id) : undefined;
  }
  delegationRoots() {
    return this.database
      .all(
        `SELECT DISTINCT m.id,m.bot_id,m.conversation_id,m.request_id
      FROM messages m JOIN chat_jobs j ON j.message_id=m.id
      JOIN bot_delegations d ON d.parent_message_id=m.id
      JOIN conversations c ON c.id=m.conversation_id
      WHERE m.status IN ('streaming','interrupted') AND d.state IN ('waiting','complete')
      AND c.kind!='pursuit_run' AND (j.approval_step_json IS NOT NULL OR (d.mode='fire_and_forget' AND d.delivered=0))
      AND NOT EXISTS (SELECT 1 FROM bot_delegations p WHERE p.conversation_id=m.conversation_id
        AND p.child_request_id=m.request_id AND p.state='waiting')`,
      )
      .map((row) => ({
        messageId: String(row.id),
        botId: String(row.bot_id),
        conversationId: String(row.conversation_id),
        requestId: String(row.request_id),
      }))
      .filter((row) => this.resumableDelegation(row.messageId));
  }
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
