import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Clock3, Search, X } from 'lucide-react';
import type { ChatMessage } from '../../../../shared/ai';
import type { TrajectoryDetail, TrajectoryRecord } from '../../../../shared/trajectory';
import { startPoll } from '../../services/poll';
import { trajectoryService } from '../../services/trajectoryService';
import { useWorkspaceTime } from '../timezone/WorkspaceTimeContext';
import { AttachmentCard } from './AttachmentCard';
import { TrajectoryToolDetails } from './TrajectoryToolDetails';
import { trajectoryRows, trajectoryTurns, type TrajectoryRow } from './trajectoryData';
import './TrajectoryView.css';

const pageSize = 30;
const emptyRecords: TrajectoryRecord[] = [];
const rowNames = {
  system: 'System',
  user: 'User',
  context: 'Context',
  model: 'Assistant',
  tool: 'Tool',
  compaction: 'Compaction',
};

function flatten(rows: TrajectoryRow[]): TrajectoryRow[] {
  return rows.flatMap((row) => [row, ...flatten(row.children || [])]);
}

function matchingRows(rows: TrajectoryRow[], query: string): TrajectoryRow[] {
  return rows.flatMap((row) => {
    if (
      `${rowNames[row.kind]} ${row.label} ${row.text} ${row.status || ''}`
        .toLowerCase()
        .includes(query)
    )
      return [row];
    const children = matchingRows(row.children || [], query);
    return children.length ? [{ ...row, children }] : [];
  });
}

function elapsed(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function duration(row: TrajectoryRow) {
  return row.start !== undefined && row.end !== undefined
    ? elapsed(Math.max(0, row.end - row.start))
    : '';
}

function Overview({
  turns,
  timed,
  onSelect,
}: {
  turns: TrajectoryRow[][];
  timed: boolean;
  onSelect: (row: TrajectoryRow) => void;
}) {
  let offset = 0;
  const spans = turns.flatMap((turn) => {
    const rows = flatten(turn);
    if (!timed) return rows.map((row) => ({ row, start: offset++, width: 1 }));
    const known = rows.flatMap((row) =>
      row.start === undefined ? [] : [{ row, start: row.start, end: row.end ?? row.start }],
    );
    if (!known.length) return [];
    const start = known.reduce((value, span) => Math.min(value, span.start), Infinity);
    const end = known.reduce((value, span) => Math.max(value, span.end), start);
    const result = known.map((span) => ({
      row: span.row,
      start: offset + span.start - start,
      width: Math.max(0, span.end - span.start),
    }));
    offset += Math.max(1, end - start + 1);
    return result;
  });
  if (!spans.length) return null;
  return (
    <div
      className="trajectory-overview"
      aria-label={timed ? 'Recorded durations' : 'Event sequence'}
    >
      {['Input', 'Model', 'Tools'].map((label, lane) => (
        <div className="trajectory-lane" key={label}>
          <span>{label}</span>
          <div>
            {spans
              .filter(
                ({ row }) =>
                  (row.kind === 'tool'
                    ? 2
                    : row.kind === 'model' || row.kind === 'compaction'
                      ? 1
                      : 0) === lane,
              )
              .map(({ row, start, width }) => (
                <button
                  key={row.id}
                  type="button"
                  tabIndex={-1}
                  className={`trajectory-bar trajectory-${row.kind}`}
                  style={{
                    left: `${(start / offset) * 100}%`,
                    width: `${(width / offset) * 100}%`,
                  }}
                  title={`${row.label}${duration(row) ? ` · ${duration(row)}` : ''}`}
                  aria-label={`Show ${row.label}`}
                  onClick={() => onSelect(row)}
                />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Inspector({
  row,
  conversationId,
  onClose,
}: {
  row: TrajectoryRow;
  conversationId: string;
  onClose: () => void;
}) {
  const { time } = useWorkspaceTime();
  const [detail, setDetail] = useState<TrajectoryDetail>();
  const [error, setError] = useState('');
  const record = row.record;
  const isTool = row.kind === 'tool';
  const recordId = record?.id;
  const status = record?.status;
  const outputPreview = record?.preview;
  useEffect(() => {
    if (recordId === undefined) return;
    let current = true;
    const read = async () => {
      try {
        const value = await trajectoryService.detail(conversationId, recordId);
        if (current) {
          setDetail(value);
          setError('');
        }
      } catch {
        if (current) setError('Could not load this record.');
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [conversationId, recordId, status, outputPreview]);

  let sections: [string, string | undefined][] = [];
  if (row.kind === 'system') sections = [['System prompt', detail?.system]];
  else if (row.contextIndex !== undefined)
    sections = [['Context', detail?.context?.[row.contextIndex]]];
  else if (record)
    sections = [
      ['Input', detail?.input],
      ['Reasoning', detail?.reasoning],
      ['Output', detail?.output],
      ['Error', detail?.error],
    ];
  const usage = record?.usage;
  const counts: [string, number | undefined][] = [
    ['Input', usage?.input],
    ['Output', usage?.output],
    ['Cached input', usage?.cached],
    ['Reasoning', usage?.reasoning],
  ];
  return (
    <aside className="trajectory-inspector" aria-label="Trajectory record details">
      <header>
        <div className="trajectory-inspector-title" title={row.label}>
          {isTool && (
            <span className="trajectory-tag trajectory-tool">
              {record?.parentCallId || row.activity?.parentToolCallId ? 'Subcall' : 'Tool'}
            </span>
          )}
          <strong>{isTool ? (record?.title ?? row.activity?.tool ?? row.label) : row.label}</strong>
        </div>
        <button type="button" aria-label="Close record details" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {isTool ? (
        <TrajectoryToolDetails row={row} detail={detail} duration={duration(row)} error={error} />
      ) : (
        <div className="trajectory-inspector-body">
          <div className="trajectory-metrics">
            {row.status && <span>{row.status}</span>}
            {row.start !== undefined && <span>{time(new Date(row.start).toISOString())}</span>}
            {duration(row) && <span>{duration(row)}</span>}
            {record?.firstTokenAt !== undefined && row.kind === 'model' && (
              <span>
                First token {elapsed(Math.max(0, record.firstTokenAt - record.startedAt))}
              </span>
            )}
            {row.kind === 'model' &&
              counts.map(([label, count]) =>
                count === undefined ? null : (
                  <span key={label}>
                    {label} {count.toLocaleString()} tokens
                  </span>
                ),
              )}
          </div>
          {error && <p role="alert">{error}</p>}
          {record && !detail && !error && <p role="status">Loading record…</p>}
          {row.text && (!record || error) && <pre tabIndex={0}>{row.text}</pre>}
          {sections.map(([label, value]) =>
            value ? (
              <section key={label}>
                <h4>{label}</h4>
                <pre tabIndex={0}>{value}</pre>
              </section>
            ) : null,
          )}
          {row.attachments?.map((file) => (
            <AttachmentCard key={file.id} attachment={file} />
          ))}
        </div>
      )}
    </aside>
  );
}

export function TrajectoryView({
  conversationId,
  messages,
  loading,
  busy,
}: {
  conversationId: string;
  messages: ChatMessage[];
  loading: boolean;
  busy: boolean;
}) {
  const prefix = useId();
  const ledger = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [records, setRecords] = useState<TrajectoryRecord[]>(emptyRecords);
  const [loadError, setLoadError] = useState('');
  const [reading, setReading] = useState(true);
  const [count, setCount] = useState(pageSize);
  const [query, setQuery] = useState('');
  const [timed, setTimed] = useState(false);
  const [foldTurns, setFoldTurns] = useState(false);
  const [foldCalls, setFoldCalls] = useState(false);
  const [foldSubcalls, setFoldSubcalls] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string>();
  const turns = useMemo(() => trajectoryTurns(messages), [messages]);
  const first = Math.max(0, turns.length - count);
  const from = turns[first]?.[0]?.id;
  useEffect(() => {
    if (loading) return;
    let current = true;
    let previous: TrajectoryRecord[] | undefined;
    const poll = startPoll(
      async () => {
        try {
          const data = await trajectoryService.list(conversationId, from);
          if (!current) return false;
          setRecords(data);
          setLoadError('');
          setReading(false);
          const changed = previous !== data;
          previous = data;
          return changed;
        } catch {
          if (current) {
            setLoadError('Could not load recorded requests. Showing saved chat activity.');
            setReading(false);
          }
          return false;
        }
      },
      { interval: 650, maxInterval: busy ? 1300 : 6000 },
    );
    return () => {
      current = false;
      poll.stop();
    };
  }, [from, conversationId, loading, busy]);

  const rows = useMemo(() => trajectoryRows(turns.slice(first), records), [turns, first, records]);
  const search = query.trim().toLowerCase();
  const visible = useMemo(
    () => (search ? rows.map((turn) => matchingRows(turn, search)) : rows),
    [rows, search],
  );
  const selection = useMemo(
    () => (selected ? flatten(rows.flat()).find((row) => row.id === selected) : undefined),
    [rows, selected],
  );

  useLayoutEffect(() => {
    if (follow.current && !search && !selected && ledger.current)
      ledger.current.scrollTop = ledger.current.scrollHeight;
  }, [visible, search, selected]);

  function jump(row: TrajectoryRow) {
    setFoldTurns(false);
    setFoldCalls(false);
    setFoldSubcalls(false);
    setOverrides({});
    follow.current = false;
    setSelected(row.id);
    requestAnimationFrame(() =>
      document.getElementById(`${prefix}-${row.id}`)?.scrollIntoView({ block: 'nearest' }),
    );
  }

  const toggle = (id: string, value: boolean) =>
    setOverrides((previous) => ({ ...previous, [id]: value }));
  function renderRow(row: TrajectoryRow, depth = 0) {
    const folded =
      !search && (overrides[row.id] ?? (row.kind === 'tool' ? foldSubcalls : foldCalls));
    const expandable = Boolean(row.children?.length);
    return (
      <div key={row.id}>
        <div
          id={`${prefix}-${row.id}`}
          className={`trajectory-row${selected === row.id ? ' is-selected' : ''}`}
          style={{ paddingInlineStart: 12 + Math.min(depth, 8) * 16 }}
        >
          {expandable ? (
            <button
              type="button"
              className="trajectory-chevron"
              aria-label={`${folded ? 'Expand' : 'Collapse'} ${row.label}`}
              aria-expanded={!folded}
              onClick={() => toggle(row.id, !folded)}
            >
              <ChevronRight size={14} />
            </button>
          ) : (
            <span className="trajectory-chevron" />
          )}
          <button
            type="button"
            className="trajectory-row-content"
            onClick={() => {
              follow.current = false;
              setSelected(row.id);
            }}
          >
            <span className={`trajectory-tag trajectory-${row.kind}`}>
              {row.kind === 'tool' && (row.record?.parentCallId || row.activity?.parentToolCallId)
                ? 'Subcall'
                : rowNames[row.kind]}
            </span>
            <span className="trajectory-row-label">{row.label}</span>
            <span className="trajectory-preview">
              {row.text ||
                (row.attachments?.length
                  ? `${row.attachments.length} attachment${row.attachments.length === 1 ? '' : 's'}`
                  : '')}
            </span>
            {row.status && row.status !== 'complete' && (
              <span className={`trajectory-status is-${row.status}`}>{row.status}</span>
            )}
            {duration(row) && <span className="trajectory-duration">{duration(row)}</span>}
          </button>
        </div>
        {!folded && row.children?.map((child) => renderRow(child, depth + 1))}
      </div>
    );
  }

  return (
    <section className="trajectory-view" aria-label="Conversation trajectory">
      <div className="trajectory-toolbar" role="group" aria-label="Trajectory controls">
        <button
          type="button"
          aria-pressed={timed}
          title="Use recorded durations within each turn"
          onClick={() => setTimed(!timed)}
        >
          <Clock3 size={13} /> Duration
        </button>
        {(
          [
            ['Turns', foldTurns, setFoldTurns],
            ['Calls', foldCalls, setFoldCalls],
            ['Subcalls', foldSubcalls, setFoldSubcalls],
          ] as const
        ).map(([label, folded, setFolded]) => (
          <button
            key={label}
            type="button"
            aria-pressed={folded}
            disabled={!!search}
            title={`${folded ? 'Expand' : 'Collapse'} ${label.toLowerCase()}`}
            onClick={() => {
              setOverrides({});
              setFolded(!folded);
            }}
          >
            <ChevronRight size={13} />
            {label}
          </button>
        ))}
        <label className="trajectory-search">
          <Search size={13} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search visible history"
            aria-label="Search trajectory"
          />
        </label>
      </div>
      <Overview turns={visible} timed={timed} onSelect={jump} />
      <div className="trajectory-workspace">
        <div
          className="trajectory-ledger"
          ref={ledger}
          onScroll={() => {
            const element = ledger.current;
            if (element)
              follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
          }}
        >
          {loadError && (
            <p className="trajectory-notice" role="status">
              {loadError}
            </p>
          )}
          {(loading || reading) && !loadError && (
            <p className="trajectory-notice" role="status">
              Loading trajectory…
            </p>
          )}
          {first > 0 && (
            <button
              type="button"
              className="trajectory-older"
              onClick={() => {
                follow.current = false;
                setCount(count + pageSize);
              }}
            >
              Load earlier turns
            </button>
          )}
          {!loading && !visible.some((turn) => turn.length) && (
            <p className="trajectory-notice">
              {search
                ? 'No matching records in visible history.'
                : 'Send a message to start a trajectory.'}
            </p>
          )}
          {visible.map((turn, index) => {
            if (!turn.length) return null;
            const id = `turn-${turns[first + index][0].id}`;
            const folded = !search && (overrides[id] ?? foldTurns);
            return (
              <section className="trajectory-turn" key={id}>
                <button
                  type="button"
                  className="trajectory-turn-toggle"
                  aria-expanded={!folded}
                  onClick={() => toggle(id, !folded)}
                >
                  <ChevronRight size={14} />
                  Turn {first + index + 1}
                </button>
                {!folded && turn.map((row) => renderRow(row))}
              </section>
            );
          })}
        </div>
        {selection && (
          <Inspector
            key={selection.id}
            row={selection}
            conversationId={conversationId}
            onClose={() => setSelected(undefined)}
          />
        )}
      </div>
    </section>
  );
}
