import { useMemo } from 'react';
import { Database, Gauge } from 'lucide-react';
import type { ChatMessage, ContextUsage } from '../../../../shared/ai';
import type { TrajectoryMessageStats } from '../../../../shared/trajectory';
import { Tooltip } from '../../components/ui/Tooltip';
import { MessageActions } from '../chat/MessageActions';
import { useWorkspaceTime } from '../timezone/WorkspaceTimeContext';
import { responsePresentation } from '../../../../shared/responseParts';
import { ContextMeter } from './ContextMeter';
import { trajectoryTurns } from './trajectoryData';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

type Reading = {
  total?: number;
  estimated?: boolean;
  steps: number;
  cacheInput: number;
  cached: number;
  timedOutput: number;
  decodeMs: number;
  speedEstimated: boolean;
};

function turnReading(usage?: ContextUsage, stats?: TrajectoryMessageStats): Reading {
  return {
    total:
      usage?.runTokens ??
      (stats?.input !== undefined && stats.output !== undefined
        ? stats.input + stats.output
        : undefined),
    estimated: usage?.runEstimated,
    steps: stats?.steps ?? 0,
    cacheInput: stats?.cacheInput ?? 0,
    cached: stats?.cached ?? 0,
    timedOutput: stats?.timedOutput ?? 0,
    decodeMs: stats?.decodeMs ?? 0,
    speedEstimated: stats?.speedEstimated ?? false,
  };
}

function cacheHit(reading: Reading) {
  return reading.cacheInput > 0
    ? `${Math.round((reading.cached / reading.cacheInput) * 100)}%`
    : undefined;
}

function speed(reading: Reading) {
  return reading.decodeMs > 0
    ? `${reading.speedEstimated ? '≈ ' : ''}${Math.round((reading.timedOutput * 1000) / reading.decodeMs)} tok/s`
    : undefined;
}

function UsagePill({
  reading,
  usage,
  stats,
  turn = false,
}: {
  reading: Reading;
  usage?: ContextUsage;
  stats?: TrajectoryMessageStats;
  turn?: boolean;
}) {
  const hit = cacheHit(reading);
  const rate = speed(reading);
  const total =
    reading.total === undefined
      ? undefined
      : `${reading.estimated ? '≈ ' : ''}${compact.format(reading.total)} tok`;
  const label = turn
    ? ['Usage', total].filter(Boolean).join(' ')
    : [total, hit && `Cache hit ${hit}`].filter(Boolean).join(' · ');
  const context = usage?.contextWindow
    ? `${usage.estimated ? '≈ ' : ''}${Math.min(100, Math.round((usage.usedTokens / usage.contextWindow) * 100))}%`
    : undefined;
  const facts: [string, string | undefined][] = [
    [
      turn ? 'Total tokens' : 'Recorded total',
      reading.total === undefined
        ? undefined
        : `${reading.estimated ? '≈ ' : ''}${reading.total.toLocaleString()}`,
    ],
    [
      stats?.input === undefined ? 'Last model input' : 'Model input',
      (stats?.input ?? usage?.inputTokens)?.toLocaleString(),
    ],
    [
      stats?.output === undefined ? 'Last model output' : 'Model output',
      (stats?.output ?? usage?.outputTokens)?.toLocaleString(),
    ],
    ['Cache hit (reported input)', hit],
    ['Generation speed', rate],
    ['Recorded steps', reading.steps ? String(reading.steps) : undefined],
    ['Context used', context],
    ['Compactions', usage?.compactions ? String(usage.compactions) : undefined],
  ];
  const recorded = facts.filter((fact): fact is [string, string] => fact[1] !== undefined);
  return (
    <Tooltip
      label={turn ? `Response ${label.toLowerCase()}` : `Conversation usage: ${label}`}
      clickTrigger={{
        className: 'chat-stats-pill',
        content: (
          <>
            <Database size={13} aria-hidden="true" />
            {label}
          </>
        ),
      }}
      content={
        <>
          <strong>{turn ? 'Response usage' : 'Conversation usage'}</strong>
          {recorded.length ? (
            <dl className="chat-stats-details">
              {recorded.map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>No usage was recorded for this response.</p>
          )}
        </>
      }
    />
  );
}

export function ConversationStats({
  messages,
  stats,
  window,
  usage,
  loading,
}: {
  messages: ChatMessage[];
  stats: Map<string, TrajectoryMessageStats>;
  window: number | null;
  usage?: ContextUsage;
  loading: boolean;
}) {
  const fresh = !loading && messages.length === 0;
  const reading = useMemo(() => {
    const total = turnReading();
    if (fresh) total.total = 0;
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const turn = turnReading(message.contextUsage, stats.get(message.id));
      if (turn.total !== undefined) total.total = (total.total ?? 0) + turn.total;
      total.estimated ||= turn.estimated;
      total.steps += turn.steps;
      total.cacheInput += turn.cacheInput;
      total.cached += turn.cached;
      total.timedOutput += turn.timedOutput;
      total.decodeMs += turn.decodeMs;
      total.speedEstimated ||= turn.speedEstimated;
    }
    return total;
  }, [messages, stats, fresh]);
  const turns = useMemo(() => trajectoryTurns(messages).length, [messages]);
  const rate = speed(reading);
  return (
    <div className="conversation-stats" aria-label="Conversation statistics">
      {(turns > 0 || fresh) && (
        <span className="chat-stats-reading">
          <Gauge size={13} aria-hidden="true" />
          {turns} {turns === 1 ? 'turn' : 'turns'}
          {(reading.steps > 0 || fresh) &&
            ` · ${reading.steps} ${reading.steps === 1 ? 'step' : 'steps'}`}
          {rate && ` · ${rate}`}
        </span>
      )}
      {(reading.total !== undefined || cacheHit(reading)) && <UsagePill reading={reading} />}
      <ContextMeter usage={usage} window={window} />
    </div>
  );
}

export function TurnFooter({
  message,
  stats,
  latest,
}: {
  message: ChatMessage;
  stats?: TrajectoryMessageStats;
  latest: boolean;
}) {
  const { time } = useWorkspaceTime();
  const timestamp = message.finishedAt ?? message.createdAt;
  return (
    <MessageActions
      className={`turn-footer${latest ? ' is-latest' : ''}`}
      text={responsePresentation(message).answer || message.content}
    >
      <UsagePill
        reading={turnReading(message.contextUsage, stats)}
        usage={message.contextUsage}
        stats={stats}
        turn
      />
      <time dateTime={timestamp}>{time(timestamp)}</time>
    </MessageActions>
  );
}
