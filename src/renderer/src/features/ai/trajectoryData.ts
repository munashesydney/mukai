import type { ChatActivity, ChatMessage, ResponsePart } from '../../../../shared/ai';
import { responsePresentation } from '../../../../shared/responseParts';
import type { TrajectoryRecord } from '../../../../shared/trajectory';

export interface TrajectoryRow {
  id: string;
  kind: 'system' | 'user' | 'context' | 'model' | 'tool' | 'compaction';
  label: string;
  text: string;
  start?: number;
  end?: number;
  status?: string;
  record?: TrajectoryRecord;
  contextIndex?: number;
  activity?: ChatActivity;
  attachments?: ChatMessage['attachments'];
  children?: TrajectoryRow[];
}

export function trajectoryTurns(messages: ChatMessage[]) {
  const turns = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const key = message.requestId || message.id;
    const turn = turns.get(key);
    if (turn) turn.push(message);
    else turns.set(key, [message]);
  }
  return [...turns.values()];
}

function time(date?: string | null) {
  const timestamp = date ? Date.parse(date) : NaN;
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function userRow(message: ChatMessage): TrajectoryRow {
  return {
    id: message.id,
    kind: 'user',
    label: message.authorName || 'User',
    text: message.content,
    start: time(message.createdAt),
    attachments: message.attachments,
  };
}

function toolRow(activity: ChatActivity, id: string): TrajectoryRow {
  return {
    id,
    kind: 'tool',
    label: [activity.tool, activity.action, activity.path].filter(Boolean).join(' · '),
    text: activity.summary,
    status: activity.status,
    activity,
    children: [],
  };
}

function savedPart(message: ChatMessage, part: ResponsePart): TrajectoryRow | undefined {
  const id = `${message.id}-${part.id}`;
  switch (part.type) {
    case 'steering':
      return {
        id,
        kind: 'user',
        label: 'Steering',
        text: part.text,
        start: time(part.createdAt),
        attachments: part.attachments,
      };
    case 'compaction':
      return {
        id,
        kind: 'compaction',
        label: 'Context compaction',
        status: part.state,
        text: `${part.tokensBefore.toLocaleString()} tokens${part.tokensAfter === undefined ? '' : ` → ${part.tokensAfter.toLocaleString()}`}`,
        start: time(part.startedAt),
        end: time(part.finishedAt),
      };
    case 'text':
    case 'reasoning':
      return {
        id,
        kind: 'model',
        label: part.type === 'text' ? 'Assistant' : 'Reasoning',
        text: part.text,
      };
    default:
      return undefined;
  }
}

function savedRows(
  message: ChatMessage,
  tracedCalls: Set<string>,
  tracedParts: Set<string>,
  hasModel: boolean,
) {
  const parts = message.parts?.length ? message.parts : responsePresentation(message).process;
  const activities = new Map(
    (message.activity || [])
      .filter((item) => !tracedCalls.has(item.id))
      .map((item) => [item.id, toolRow(item, `${message.id}-tool-${item.id}`)]),
  );
  const roots = new Set(activities.values());
  for (const row of activities.values()) {
    const parent = row.activity?.parentToolCallId && activities.get(row.activity.parentToolCallId);
    if (parent && parent !== row) {
      parent.children!.push(row);
      roots.delete(row);
    }
  }
  const rows = parts.flatMap((part) => {
    if (part.type === 'tool') {
      const tool = activities.get(part.activityId);
      return tool && roots.delete(tool) ? [tool] : [];
    }
    if (
      tracedParts.has(part.id) ||
      ((part.type === 'text' || part.type === 'reasoning') && !part.text)
    )
      return [];
    const row = savedPart(message, part);
    return row ? [row] : [];
  });
  rows.push(...roots);
  if (!hasModel && ((!message.parts?.length && message.content) || message.error))
    rows.push({
      id: `${message.id}-answer`,
      kind: 'model',
      label: message.authorName || 'Assistant',
      text: [message.parts?.length ? '' : message.content, message.error]
        .filter(Boolean)
        .join('\n\n'),
      status: message.status,
    });
  if (!hasModel)
    return [
      {
        id: message.id,
        kind: 'model',
        label: 'Saved response',
        text: '',
        status: message.status,
        start: time(message.startedAt),
        end: time(message.finishedAt),
        children: rows,
      } satisfies TrajectoryRow,
    ];
  if (message.error)
    rows.push({
      id: `${message.id}-error`,
      kind: 'model',
      label: 'Response ended',
      text: message.error,
      status: message.status,
      start: time(message.finishedAt),
    });
  return rows;
}

export function trajectoryRows(turns: ChatMessage[][], records: TrajectoryRecord[]) {
  const byMessage = new Map<string, TrajectoryRecord[]>();
  for (const record of records) {
    const messageRecords = byMessage.get(record.messageId);
    if (messageRecords) messageRecords.push(record);
    else byMessage.set(record.messageId, [record]);
  }
  let lastSystem: string | undefined;
  return turns.map((turn) =>
    turn.flatMap((message) => {
      if (message.role === 'user') return [userRow(message)];
      const trace = byMessage.get(message.id) || [];
      const hasModel = trace.some((record) => record.kind === 'model');
      const tracedCalls = new Set(
        trace.flatMap((record) => (record.callId ? [record.callId] : [])),
      );
      const tracedParts = new Set(trace.flatMap((record) => record.partIds ?? []));
      const saved = savedRows(message, tracedCalls, tracedParts, hasModel);
      if (!trace.length) return saved;
      const rows = new Map<number, TrajectoryRow>();
      const calls = new Map<string, TrajectoryRow>();
      for (const record of trace) {
        const activity = record.callId
          ? message.activity?.find((item) => item.id === record.callId)
          : undefined;
        const row: TrajectoryRow = {
          id: `record-${record.id}`,
          kind: record.kind,
          label: record.title,
          text: record.preview || '',
          status: record.status,
          start: record.startedAt,
          end: record.finishedAt,
          record,
          activity,
          children: [],
        };
        rows.set(record.id, row);
        if (record.callId) calls.set(`${record.stepId}/${record.callId}`, row);
      }
      const top: TrajectoryRow[] = [];
      for (const record of trace) {
        const row = rows.get(record.id)!;
        if (record.kind === 'model') {
          if (record.systemPreview && record.systemKey !== lastSystem)
            top.push({
              id: `${row.id}-system`,
              kind: 'system',
              label: 'System prompt',
              text: record.systemPreview,
              record,
              start: record.startedAt,
            });
          lastSystem = record.systemKey;
          for (const [contextIndex, text] of (record.contextPreviews || []).entries())
            top.push({
              id: `${row.id}-context-${contextIndex}`,
              kind: 'context',
              label: 'Injected context',
              text,
              record,
              contextIndex,
              start: record.startedAt,
            });
        }
        const parent = record.parentCallId
          ? calls.get(`${record.stepId}/${record.parentCallId}`)
          : undefined;
        const owner =
          parent && parent !== row ? parent : record.stepId ? rows.get(record.stepId) : undefined;
        if (owner) owner.children!.push(row);
        else top.push(row);
      }
      return [...top, ...saved].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
    }),
  );
}
