import type { CSSProperties } from 'react';
import type { ContextUsage } from '../../../../shared/ai';
import { Tooltip } from '../../components/ui/Tooltip';

export function ContextMeter({
  usage,
  window,
  onConfigure,
}: {
  usage?: ContextUsage;
  window: number | null;
  onConfigure?: () => void;
}) {
  const capacity = usage?.contextWindow ?? window;
  const used = usage?.usedTokens ?? 0;
  const percentage = capacity ? Math.min(100, Math.round((used / capacity) * 100)) : null;
  const format = (value: number) => value.toLocaleString();
  const label =
    usage?.phase === 'compacting'
      ? 'Compacting…'
      : usage?.phase === 'failed'
        ? 'Compaction paused'
        : capacity
          ? `${usage?.estimated ? '≈ ' : ''}${percentage}% context`
          : 'Context size unknown';
  const detail = [
    `${usage?.estimated ? 'Estimated' : 'Reported'} context: ${format(used)}${capacity ? ` / ${format(capacity)}` : ''} tokens.`,
    usage?.inputTokens != null ? `Last input: ${format(usage.inputTokens)} tokens.` : '',
    usage?.outputTokens != null ? `Last output: ${format(usage.outputTokens)} tokens.` : '',
    usage
      ? `${usage.runEstimated ? 'Estimated run total' : 'Run total'}: ${format(usage.runTokens)} tokens. Compactions: ${usage.compactions}.`
      : '',
    !capacity
      ? 'Set the model’s context-window size in model settings.'
      : 'History is compacted automatically before the working context fills.',
  ]
    .filter(Boolean)
    .join('\n');
  const className = `context-meter${usage?.phase === 'compacting' ? ' is-compacting' : ''}`;
  const content = (
    <>
      <span
        className="context-meter-ring"
        aria-hidden="true"
        style={{ '--context-progress': `${percentage ?? 0}%` } as CSSProperties}
      />
      <span>{label}</span>
    </>
  );
  if (onConfigure)
    return (
      <button
        type="button"
        className={className}
        title={detail}
        aria-label={`${label}. ${detail}`}
        onClick={onConfigure}
      >
        {content}
      </button>
    );
  return (
    <Tooltip
      label={label}
      content={<span className="context-meter-details">{detail}</span>}
      clickTrigger={{ className, content }}
    />
  );
}
