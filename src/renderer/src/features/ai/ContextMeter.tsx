import type { CSSProperties } from 'react';
import type { ContextUsage } from '../../../../shared/ai';

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
  return (
    <button
      type="button"
      className={`context-meter${usage?.phase === 'compacting' ? ' is-compacting' : ''}`}
      title={detail}
      aria-label={`${label}. ${detail}`}
      onClick={onConfigure}
      disabled={!onConfigure}
      style={{ '--context-progress': `${percentage ?? 0}%` } as CSSProperties}
    >
      <span className="context-meter-ring" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
