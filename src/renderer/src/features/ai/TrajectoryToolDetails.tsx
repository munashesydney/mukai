import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import { formatTimestamp } from '../../../../shared/timeZone';
import type { TrajectoryDetail } from '../../../../shared/trajectory';
import { useWorkspaceTime } from '../timezone/WorkspaceTimeContext';
import type { TrajectoryRow } from './trajectoryData';

const detailTabs = ['Payload', 'Result', 'Schema', 'Timing'] as const;
const tabs = ['Summary', ...detailTabs] as const;
type Tab = (typeof tabs)[number];

function formatJson(value: string | undefined, unwrapResult = false): string | undefined {
  if (value === undefined) return;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      unwrapResult &&
      parsed &&
      typeof parsed === 'object' &&
      'type' in parsed &&
      'value' in parsed
    ) {
      if (
        (parsed.type === 'text' || parsed.type === 'error-text') &&
        typeof parsed.value === 'string'
      )
        return formatJson(parsed.value);
      if (parsed.type === 'json' || parsed.type === 'error-json')
        return JSON.stringify(parsed.value, null, 2);
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

function ToolText({ value, empty, preview }: { value?: string; empty: string; preview: boolean }) {
  return value ? (
    <pre className="trajectory-tool-text" tabIndex={preview ? undefined : 0}>
      {value}
    </pre>
  ) : (
    <p className="trajectory-tool-empty">{empty}</p>
  );
}

export function TrajectoryToolDetails({
  row,
  detail,
  duration,
  error,
}: {
  row: TrajectoryRow;
  detail?: TrajectoryDetail;
  duration: string;
  error: string;
}) {
  const id = useId();
  const { timeZone } = useWorkspaceTime();
  const [active, setActive] = useState<Tab>('Summary');
  const loading = Boolean(row.record && !detail && !error);
  const payload = useMemo(() => formatJson(detail?.input), [detail?.input]);
  const result = useMemo(
    () => formatJson(detail?.output ?? row.text, true),
    [detail?.output, row.text],
  );
  const schema = useMemo(
    () => formatJson(detail?.schema?.parameters),
    [detail?.schema?.parameters],
  );
  const preview = active === 'Summary';
  const timestamp = (value: number) =>
    formatTimestamp(value, timeZone, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });

  function select(tab: Tab) {
    setActive(tab);
    document.getElementById(`${id}-${tab}`)?.focus();
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = (index + tabs.length - 1) % tabs.length;
        break;
      case 'ArrowRight':
        next = (index + 1) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    select(tabs[next]);
  }

  const sections = {
    Payload: (
      <ToolText
        value={payload}
        empty="Arguments weren’t recorded for this call."
        preview={preview}
      />
    ),
    Result: (
      <>
        <ToolText
          value={result || detail?.error}
          empty={row.status === 'running' ? 'Waiting for a result…' : 'No result was recorded.'}
          preview={preview}
        />
        {!preview && result && detail?.error && <p role="status">{detail.error}</p>}
      </>
    ),
    Schema: (
      <>
        {detail?.schema?.description && (
          <p className="trajectory-tool-description">{detail.schema.description}</p>
        )}
        <ToolText value={schema} empty="Schema wasn’t recorded for this call." preview={preview} />
      </>
    ),
    Timing: (
      <dl className="trajectory-tool-facts">
        <dt>Started</dt>
        <dd>{row.start === undefined ? 'Unavailable' : timestamp(row.start)}</dd>
        <dt>Duration</dt>
        <dd>{duration || (row.status === 'running' ? 'In progress' : 'Unavailable')}</dd>
        {!preview && row.end !== undefined && (
          <>
            <dt>Finished</dt>
            <dd>{timestamp(row.end)}</dd>
          </>
        )}
      </dl>
    ),
  };

  return (
    <>
      <div className="trajectory-inspector-tabs" role="tablist" aria-label="Tool call details">
        {tabs.map((tab, index) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`${id}-${tab}`}
            aria-controls={`${id}-panel`}
            aria-selected={active === tab}
            tabIndex={active === tab ? 0 : -1}
            onClick={() => select(tab)}
            onKeyDown={(event) => navigate(event, index)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div
        key={active}
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${active}`}
        tabIndex={0}
        className="trajectory-inspector-body"
        aria-busy={loading}
      >
        {error && <p role="alert">{error}</p>}
        {loading && <p role="status">Loading record…</p>}
        {preview ? (
          <>
            <dl className="trajectory-tool-facts">
              <dt>Status</dt>
              <dd className="trajectory-tool-status">{row.status || 'Unavailable'}</dd>
            </dl>
            {detailTabs.map((tab) => (
              <section key={tab} className="trajectory-tool-section">
                <button
                  type="button"
                  className="trajectory-tool-section-link"
                  aria-label={`Open ${tab} tab`}
                  onClick={() => select(tab)}
                >
                  {tab}
                  <ChevronRight size={12} />
                </button>
                <div
                  className={`trajectory-tool-preview trajectory-tool-preview--${tab.toLowerCase()}`}
                >
                  {(!loading || tab === 'Timing') && sections[tab]}
                </div>
              </section>
            ))}
          </>
        ) : (
          (!loading || active === 'Timing') && sections[active]
        )}
      </div>
    </>
  );
}
