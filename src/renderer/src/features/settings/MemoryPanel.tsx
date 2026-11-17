import { useWorkspaceTime } from '../timezone/WorkspaceTimeContext';
import { ConfirmationModal } from '../../components/ui/ConfirmationModal';
import { PageLoader } from '../../components/ui/PageLoader';
import { SettingsHeading } from './SettingsHeading';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, Search, Upload, X } from 'lucide-react';
import { memoryService } from '../../services/memoryService';
import { startPoll } from '../../services/poll';
import {
  MEMORY_BACKUP_MAX_BYTES,
  type MemoryFact,
  type MemoryFactDetails,
  type MemorySettings,
  type MemorySnapshot,
} from '../../../../shared/memory';
import { errorText } from '../../utils/errors';
import { MemoryGraph } from './MemoryGraph';
import { MemoryRuns } from './MemoryRuns';
import { Checkbox } from '../../components/ui/Checkbox';
import { IconButton } from '../../components/ui/IconButton';
import { Toggle } from '../../components/ui/Toggle';
import { MemoryPagination } from './MemoryPagination';
import { MemoryActivity } from './MemoryActivity';
import { MemoryRecalls } from './MemoryRecalls';
import { MemoryTabHeading } from './MemoryTabHeading';
import { memorySourceLabel, reviewMessages } from './memoryEvidence';

const memoryTabs = [
  ['graph', 'Graph'],
  ['list', 'Memories'],
  ['activity', 'Captures'],
  ['runs', 'Reviews'],
  ['recall', 'Recall'],
  ['preferences', 'Preferences'],
] as const;
const factsPerPage = 24;

function factStatus(fact: MemoryFact) {
  if (fact.validFrom === fact.validTo) return 'Retracted';
  if (fact.validFrom > new Date().toISOString()) return 'Future';
  if (fact.validTo && fact.validTo <= new Date().toISOString()) return 'Historical';
  return fact.state === 'uncertain' ? 'Unresolved' : 'Current';
}

export function MemoryPanel({ workspaceId }: { workspaceId: string }) {
  const { dateTime: time } = useWorkspaceTime();
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<(typeof memoryTabs)[number][0]>('graph');
  const [selected, setSelected] = useState<MemoryFact | null>(null);
  const selectedId = selected?.id;
  const [details, setDetails] = useState<MemoryFactDetails | null>(null);
  const [detailsError, setDetailsError] = useState('');
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(''),
    [object, setObject] = useState('');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<
    'forget' | 'clear' | { episodeId: string } | null
  >(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const resultsPanel = useRef<HTMLDivElement>(null);
  const detailPanel = useRef<HTMLElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const refreshSequence = useRef(0);
  const cancelRefresh = useCallback(() => {
    refreshSequence.current++;
  }, []);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const next = await memoryService.snapshot(workspaceId, query, history, page, factsPerPage);
    if (sequence === refreshSequence.current) {
      setSnapshot(next);
      setLoading(false);
    }
  }, [workspaceId, query, history, page]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void refresh().catch((error) => {
        if (live) {
          setError(errorText(error));
          setLoading(false);
        }
      });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
      cancelRefresh();
    };
  }, [refresh, cancelRefresh]);
  useEffect(() => {
    if (!selectedId) return;
    detailPanel.current?.focus({ preventScroll: true });
    detailPanel.current?.scrollIntoView({ block: 'nearest' });
    let live = true;
    setDetailsError('');
    void memoryService.details(workspaceId, selectedId).then(
      (data) => {
        if (live) setDetails(data);
      },
      (error) => {
        if (live) setDetailsError(errorText(error));
      },
    );
    return () => {
      live = false;
    };
  }, [selectedId, workspaceId]);
  const pollUpdates = Boolean(
    snapshot &&
    (view === 'runs' ||
      view === 'activity' ||
      view === 'recall' ||
      snapshot.embedding.status === 'loading'),
  );
  useEffect(() => {
    if (!pollUpdates || busy) return;
    const poll = startPoll(
      () =>
        refresh().catch(() => {
          /* A failed read just means the next tick tries again. */
        }),
      { interval: 3000, immediate: false },
    );
    return () => poll.stop();
  }, [pollUpdates, busy, refresh]);
  async function reload() {
    setError('');
    setNotice('');
    setLoading(true);
    try {
      await refresh();
    } catch (error) {
      setError(errorText(error));
      setLoading(false);
    }
  }
  async function perform<T>(action: () => Promise<T>, message: string | ((result: T) => string)) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await action();
      setConfirmation(null);
      setNotice(typeof message === 'function' ? message(result) : message);
      await refresh();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const choose = (fact: MemoryFact) => {
    if (
      document.activeElement instanceof HTMLElement &&
      !detailPanel.current?.contains(document.activeElement)
    )
      detailTrigger.current = document.activeElement;
    setSelected(fact);
    setEdit(false);
    setConfirmation(null);
    setText(fact.text);
    setObject(fact.object);
  };
  const changePage = (next: number) => {
    setSelected(null);
    setConfirmation(null);
    setPage(next);
  };
  const changeView = (next: (typeof memoryTabs)[number][0]) => {
    setView(next);
    setConfirmation(null);
    setNotice('');
    if (snapshot) setError('');
  };
  const saveSettings = (patch: Partial<MemorySettings>) => {
    if (snapshot)
      void perform(
        () => memoryService.settings(workspaceId, { ...snapshot.settings, ...patch }),
        patch.enabled === undefined ? 'Memory preferences saved.' : '',
      );
  };
  async function exportFile() {
    const data = await memoryService.export(workspaceId);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mukai-memory.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const selectedDetails = selected && details?.fact.id === selected.id ? details : null;
  const selectedCurrent = selectedDetails?.fact ?? selected;
  return (
    <section className={`provider-panel memory-panel${!snapshot ? ' is-loading' : ''}`}>
      <SettingsHeading
        eyebrow="WORKSPACE KNOWLEDGE"
        title="Memory"
        description="Browse saved facts, see what bots recalled, and manage automatic capture."
        actions={
          <label className="memory-enabled-control">
            <span>Memory {snapshot?.settings.enabled ? 'on' : 'off'}</span>
            <Toggle
              aria-label="Enable workspace memory"
              checked={snapshot?.settings.enabled ?? false}
              disabled={busy || !snapshot}
              onChange={(event) => saveSettings({ enabled: event.target.checked })}
            />
          </label>
        }
      />
      {error && (
        <div className="ai-alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="ai-notice" role="status">
          {notice}
        </p>
      )}
      {snapshot && !snapshot.settings.enabled && (
        <p className="memory-off-notice">
          Memory is off. Bots won’t save or recall memories. Your saved memories are kept.
        </p>
      )}
      {!snapshot ? (
        error && !loading ? (
          <button className="button button--secondary" onClick={() => void reload()}>
            Try again
          </button>
        ) : (
          <PageLoader label="Loading memories…" />
        )
      ) : (
        <>
          <div className="conversation-tabs memory-tabs" role="tablist" aria-label="Memory view">
            {memoryTabs.map(([id, label], index) => (
              <button
                key={id}
                id={`memory-tab-${id}`}
                role="tab"
                aria-selected={view === id}
                aria-controls={`memory-view-${id}`}
                tabIndex={view === id ? 0 : -1}
                className={view === id ? 'is-active' : ''}
                onClick={() => changeView(id)}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === 'ArrowRight') next = (index + 1) % memoryTabs.length;
                  else if (event.key === 'ArrowLeft')
                    next = (index + memoryTabs.length - 1) % memoryTabs.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = memoryTabs.length - 1;
                  else return;
                  event.preventDefault();
                  changeView(memoryTabs[next][0]);
                  document.getElementById(`memory-tab-${memoryTabs[next][0]}`)?.focus();
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            className="memory-view"
            id={`memory-view-${view}`}
            role="tabpanel"
            aria-labelledby={`memory-tab-${view}`}
          >
            {(view === 'graph' || view === 'list') && (
              <>
                <MemoryTabHeading
                  title={view === 'graph' ? 'Graph' : 'Memories'}
                  description={
                    view === 'graph'
                      ? 'Explore relationships between the people, projects, and facts saved here.'
                      : 'Browse saved facts and inspect their evidence and history.'
                  }
                />
                <div className="memory-toolbar">
                  <div className="memory-search">
                    <Search size={15} />
                    <input
                      aria-label="Search memories"
                      placeholder="Search facts, people, projects…"
                      value={query}
                      disabled={busy}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        changePage(1);
                      }}
                    />
                    {query && (
                      <IconButton
                        label="Clear search"
                        disabled={busy}
                        onClick={() => {
                          setQuery('');
                          changePage(1);
                        }}
                      >
                        <X size={14} />
                      </IconButton>
                    )}
                  </div>
                  <IconButton
                    label="Refresh memories"
                    disabled={busy || loading}
                    onClick={() => void reload()}
                  >
                    <RefreshCw size={16} />
                  </IconButton>
                </div>
                <div className="memory-filter-row">
                  <span aria-live="polite">
                    {snapshot.factsPage.total.toLocaleString()}{' '}
                    {query ? 'matching' : history ? 'saved' : 'current'}{' '}
                    {snapshot.factsPage.total === 1 ? 'memory' : 'memories'}
                  </span>
                  <label>
                    <Checkbox
                      checked={history}
                      disabled={busy}
                      onChange={(event) => {
                        setHistory(event.target.checked);
                        changePage(1);
                      }}
                    />
                    Include history
                  </label>
                </div>
                <div className="memory-content" aria-busy={loading}>
                  <div className="memory-results" ref={resultsPanel}>
                    {view === 'graph' ? (
                      <MemoryGraph
                        key={`${snapshot.factsPage.page}:${query}:${history}`}
                        graph={snapshot.graph}
                        onSelect={choose}
                        hasQuery={Boolean(query.trim())}
                      />
                    ) : (
                      <div className="memory-list">
                        {snapshot.facts.length ? (
                          snapshot.facts.map((fact) => (
                            <button
                              key={fact.id}
                              className={`memory-record-row memory-fact ${selected?.id === fact.id ? 'is-selected' : ''}`}
                              onClick={() => choose(fact)}
                            >
                              <span className="memory-fact-heading">
                                <strong>{fact.text}</strong>
                                <span className="memory-fact-meta" data-state={factStatus(fact)}>
                                  {factStatus(fact)}
                                </span>
                              </span>
                              <small>
                                {fact.subject} → {fact.relation.replace(/_/g, ' ')} → {fact.object}
                              </small>
                            </button>
                          ))
                        ) : (
                          <div className="memory-empty">
                            {query
                              ? 'No matching memories.'
                              : 'No memories yet. Share a useful fact in chat, or import saved memories.'}
                          </div>
                        )}
                      </div>
                    )}
                    <MemoryPagination
                      {...snapshot.factsPage}
                      label="Memories"
                      onPage={(next) => {
                        changePage(next);
                        resultsPanel.current?.scrollIntoView({ block: 'start' });
                      }}
                      loading={loading || busy}
                    />
                  </div>
                  {selectedCurrent && (
                    <aside
                      className="memory-detail"
                      aria-label="Memory details"
                      ref={detailPanel}
                      tabIndex={-1}
                    >
                      <div className="memory-detail-title">
                        <strong>Memory details</strong>
                        <IconButton
                          label="Close memory details"
                          onClick={() => {
                            setSelected(null);
                            setConfirmation(null);
                            detailTrigger.current?.focus();
                          }}
                        >
                          <X size={16} />
                        </IconButton>
                      </div>
                      <p>{selectedCurrent.text}</p>
                      <dl>
                        <dt>Relationship</dt>
                        <dd>
                          {selectedCurrent.subject} → {selectedCurrent.relation} →{' '}
                          {selectedCurrent.object}
                        </dd>
                        <dt>Scope</dt>
                        <dd>Shared workspace</dd>
                        <dt>Valid from</dt>
                        <dd>{time(selectedCurrent.validFrom)}</dd>
                        {selectedCurrent.validTo && (
                          <>
                            <dt>Valid until</dt>
                            <dd>{time(selectedCurrent.validTo)}</dd>
                          </>
                        )}
                        <dt>Recorded</dt>
                        <dd>{time(selectedCurrent.createdAt)}</dd>
                        <dt>Status</dt>
                        <dd>
                          {selectedCurrent.state}
                          {selectedCurrent.supersededBy && ' · superseded'}
                        </dd>
                      </dl>
                      {detailsError && (
                        <p className="ai-alert" role="alert">
                          {detailsError}
                        </p>
                      )}
                      {!selectedDetails && !detailsError && (
                        <p className="memory-run-meta" role="status">
                          Loading evidence and history…
                        </p>
                      )}
                      {selectedDetails && (
                        <>
                          <details>
                            <summary>Source evidence ({selectedCurrent.sources.length})</summary>
                            {selectedCurrent.sources.map((source) => {
                              const messages = reviewMessages(source);
                              return (
                                <div className="memory-source" key={source.id}>
                                  <small>
                                    {memorySourceLabel[source.sourceType]} ·{' '}
                                    {time(source.referenceTime)}
                                  </small>
                                  <div className="memory-source-text">
                                    {messages.length ? (
                                      messages.map((message, index) => (
                                        <div className="memory-source-message" key={index}>
                                          <small>
                                            {message.role === 'assistant'
                                              ? 'Bot'
                                              : message.origin?.startsWith('scheduled')
                                                ? 'Scheduled prompt'
                                                : 'User'}
                                          </small>
                                          {message.content && <p>{message.content}</p>}
                                          {message.evidence
                                            ?.filter((item) => item.result)
                                            .map((item, index) => (
                                              <p key={index}>
                                                <small>
                                                  {item.tool} · {item.status}
                                                </small>
                                                {item.result}
                                              </p>
                                            ))}
                                        </div>
                                      ))
                                    ) : (
                                      <p>{source.content}</p>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </details>
                          <details>
                            <summary>Relationship history</summary>
                            {selectedDetails.history.map((fact) => (
                              <button
                                className="memory-history-item"
                                key={fact.id}
                                aria-current={fact.id === selectedCurrent.id ? 'true' : undefined}
                                onClick={() => choose(fact)}
                              >
                                {fact.text}
                                <small>
                                  {time(fact.validFrom)}
                                  {fact.validTo && ' → ' + time(fact.validTo)}
                                </small>
                              </button>
                            ))}
                          </details>
                        </>
                      )}
                      {edit ? (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            void perform(async () => {
                              await memoryService.correct(
                                workspaceId,
                                selectedCurrent.id,
                                text,
                                object,
                              );
                              setSelected(null);
                              setEdit(false);
                            }, 'Correction saved; the previous fact remains in history.');
                          }}
                        >
                          <label>
                            Corrected fact
                            <textarea
                              required
                              maxLength={1200}
                              value={text}
                              onChange={(event) => setText(event.target.value)}
                            />
                          </label>
                          <label>
                            Related entity / value
                            <input
                              required
                              maxLength={180}
                              value={object}
                              onChange={(event) => setObject(event.target.value)}
                            />
                          </label>
                          <button className="button button--primary" disabled={busy}>
                            Save correction
                          </button>
                          <button
                            type="button"
                            className="button button--ghost"
                            onClick={() => setEdit(false)}
                          >
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <div className="memory-detail-actions">
                          <button
                            className="button button--secondary"
                            disabled={
                              busy || !selectedDetails || Boolean(selectedCurrent.supersededBy)
                            }
                            onClick={() => setEdit(true)}
                          >
                            Correct
                          </button>
                          <button
                            className="button button--ghost"
                            disabled={busy || !selectedDetails}
                            onClick={() => {
                              setError('');
                              setConfirmation('forget');
                            }}
                          >
                            Forget
                          </button>
                        </div>
                      )}
                      {confirmation === 'forget' && (
                        <ConfirmationModal
                          title="Forget this memory?"
                          confirmLabel="Forget source memories"
                          busy={busy}
                          error={error}
                          onClose={() => {
                            setConfirmation(null);
                            setError('');
                          }}
                          onConfirm={() =>
                            void perform(async () => {
                              await memoryService.forget(workspaceId, selectedCurrent.id);
                              setSelected(null);
                            }, 'Memory and its source material forgotten.')
                          }
                        >
                          <p>
                            Forget this memory and all facts derived from its source statements?
                            Original chat messages remain.
                          </p>
                        </ConfirmationModal>
                      )}
                    </aside>
                  )}
                </div>
              </>
            )}
            {view === 'runs' && (
              <MemoryRuns
                key={workspaceId}
                runs={snapshot.runs}
                disabled={busy || !snapshot.settings.enabled || !snapshot.settings.automaticCapture}
                onRetry={(id) =>
                  void perform(
                    () => memoryService.retryRun(workspaceId, id),
                    'Review retry requested.',
                  )
                }
              />
            )}
            {view === 'activity' && (
              <MemoryActivity
                snapshot={snapshot}
                busy={busy}
                onRetry={(id) =>
                  void perform(
                    () => memoryService.retry(workspaceId, id),
                    'Capture retry requested.',
                  )
                }
                onForget={(episodeId) => {
                  setError('');
                  setConfirmation({ episodeId });
                }}
              />
            )}
            {view === 'recall' && <MemoryRecalls recalls={snapshot.recalls} />}
            {typeof confirmation === 'object' && confirmation && (
              <ConfirmationModal
                title="Forget this source?"
                confirmLabel="Forget source"
                busy={busy}
                error={error}
                onClose={() => {
                  setConfirmation(null);
                  setError('');
                }}
                onConfirm={() =>
                  void perform(
                    () => memoryService.forgetEpisode(workspaceId, confirmation.episodeId),
                    'Source and memories derived from it forgotten.',
                  )
                }
              >
                <p>
                  This removes the source from memory and any facts derived from it. Original chat
                  messages remain.
                </p>
              </ConfirmationModal>
            )}
            {view === 'preferences' && (
              <>
                <MemoryTabHeading
                  title="Preferences"
                  description="Choose how this workspace saves and recalls useful information."
                />
                <section
                  className="memory-record-list memory-preferences-card"
                  aria-label="Memory preferences"
                >
                  <div className="settings-card-body memory-preferences">
                    <label>
                      <Checkbox
                        checked={snapshot.settings.automaticCapture}
                        disabled={busy}
                        onChange={(event) =>
                          saveSettings({ automaticCapture: event.target.checked })
                        }
                      />
                      <span>
                        <strong>Review conversations automatically</strong>
                        <small>
                          Review chats, spaces, and pursuit runs after one minute of inactivity
                          using your configured AI. Memories from all chats are shared with every
                          bot in this workspace.
                        </small>
                      </span>
                    </label>
                    <label>
                      <Checkbox
                        checked={snapshot.settings.automaticRecall}
                        disabled={busy}
                        onChange={(event) =>
                          saveSettings({ automaticRecall: event.target.checked })
                        }
                      />
                      <span>
                        <strong>Recall before each reply</strong>
                        <small>
                          Supply relevant memories automatically, with a bounded context budget.
                        </small>
                      </span>
                    </label>
                    <div className="memory-model">
                      <div>
                        <strong>Local semantic search</strong>
                        <small>
                          {snapshot.embedding.status === 'ready'
                            ? 'BGE small · CPU model ready'
                            : 'BGE small · one-time model download'}
                          {snapshot.embedding.error && ' · ' + snapshot.embedding.error}
                        </small>
                      </div>
                      <button
                        className="button button--secondary"
                        disabled={
                          busy ||
                          !snapshot.settings.enabled ||
                          snapshot.embedding.status === 'loading'
                        }
                        onClick={() =>
                          void perform(
                            () => memoryService.embeddings(workspaceId),
                            'Local semantic search is ready.',
                          )
                        }
                      >
                        {busy || snapshot.embedding.status === 'loading'
                          ? 'Working…'
                          : snapshot.embedding.status === 'ready'
                            ? 'Rebuild embeddings'
                            : 'Download & enable'}
                      </button>
                    </div>
                    <div className="memory-budget">
                      <label>
                        <Checkbox
                          checked={snapshot.settings.semanticSearch}
                          disabled={busy || snapshot.embedding.status !== 'ready'}
                          onChange={(event) =>
                            saveSettings({ semanticSearch: event.target.checked })
                          }
                        />{' '}
                        Use semantic search
                      </label>
                      <label>
                        Recall budget{' '}
                        <select
                          value={snapshot.settings.contextTokens}
                          disabled={busy}
                          onChange={(event) =>
                            saveSettings({ contextTokens: Number(event.target.value) })
                          }
                        >
                          {[512, 1024, 1600, 2048, 4096].map((value) => (
                            <option key={value} value={value}>
                              {value} tokens
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </div>
                </section>
                <p className="memory-caption">
                  Embeddings run locally. Automatic extraction uses your configured AI, which may be
                  a remote provider. Recall marks unresolved memories as unverified.
                </p>
                <div className="memory-section-heading">
                  <h4>Memory data</h4>
                  <p>Export a backup, restore saved memories, or clear this workspace’s memory.</p>
                </div>
                <div className="memory-record-list memory-data">
                  <div className="memory-record-row">
                    <div>
                      <strong>Export a backup</strong>
                      <p>Download the saved facts in this workspace.</p>
                    </div>
                    <button
                      className="button button--secondary"
                      disabled={busy}
                      onClick={() => void perform(exportFile, 'Memory export downloaded.')}
                    >
                      <Download size={15} /> Export
                    </button>
                  </div>
                  <div className="memory-record-row">
                    <div>
                      <strong>Import memories</strong>
                      <p>Restore facts from a Mukai Memory backup.</p>
                    </div>
                    <button
                      className="button button--secondary"
                      disabled={busy}
                      onClick={() => fileInput.current?.click()}
                    >
                      <Upload size={15} /> Import
                    </button>
                  </div>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file)
                        void perform(
                          async () => {
                            if (file.size > MEMORY_BACKUP_MAX_BYTES)
                              throw new Error('Memory imports can be up to 32 MB.');
                            let backup: unknown;
                            try {
                              backup = JSON.parse(await file.text());
                            } catch {
                              throw new Error('Choose a valid Mukai Memory JSON export.');
                            }
                            return memoryService.import(workspaceId, backup);
                          },
                          ({ imported, deduplicated, revived }) =>
                            `Import complete. ${imported} added, ${revived} restored, ${deduplicated} already saved.`,
                        );
                    }}
                  />
                  <div className="memory-record-row">
                    <div>
                      <strong>Clear workspace memory</strong>
                      <p>Remove saved facts, source evidence, and recall records.</p>
                    </div>
                    <button
                      className="button button--danger"
                      disabled={busy}
                      onClick={() => {
                        setError('');
                        setConfirmation('clear');
                      }}
                    >
                      Clear memory
                    </button>
                  </div>
                </div>
                {confirmation === 'clear' && (
                  <ConfirmationModal
                    title="Clear workspace memory?"
                    confirmLabel="Clear all memory"
                    busy={busy}
                    error={error}
                    onClose={() => {
                      setConfirmation(null);
                      setError('');
                    }}
                    onConfirm={() =>
                      void perform(async () => {
                        await memoryService.clear(workspaceId);
                        setSelected(null);
                      }, 'Workspace memory cleared.')
                    }
                  >
                    <p>
                      Clear all memory in this workspace, including source evidence and recall
                      records? Original chats remain.
                    </p>
                  </ConfirmationModal>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
