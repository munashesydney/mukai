import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, Search, Upload, X } from 'lucide-react';
import { memoryService } from '../../services/memoryService';
import type { MemoryFact, MemorySettings, MemorySnapshot } from '../../../../shared/memory';
import { errorText } from '../../utils/errors';
import { MemoryGraph } from './MemoryGraph';
import { Checkbox } from '../../components/ui/Checkbox';
import { IconButton } from '../../components/ui/IconButton';

const memoryTabs = [
  ['graph', 'Graph'],
  ['list', 'Memories'],
  ['activity', 'Activity'],
  ['preferences', 'Preferences'],
] as const;

const time = (value: string) => new Date(value).toLocaleString();
export function MemoryPanel({ workspaceId }: { workspaceId: string }) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState(false);
  const [view, setView] = useState<(typeof memoryTabs)[number][0]>('graph');
  const [selected, setSelected] = useState<MemoryFact | null>(null);
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(''),
    [object, setObject] = useState('');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<'forget' | 'clear' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const refreshSequence = useRef(0);
  const cancelRefresh = useCallback(() => {
    refreshSequence.current++;
  }, []);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const next = await memoryService.snapshot(workspaceId, query, history);
    if (sequence === refreshSequence.current) setSnapshot(next);
  }, [workspaceId, query, history]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void refresh().catch((error) => {
        if (live) setError(errorText(error));
      });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
      cancelRefresh();
    };
  }, [refresh, cancelRefresh]);
  useEffect(() => {
    if (
      !snapshot?.episodes.some((episode) => ['pending', 'processing'].includes(episode.status)) &&
      snapshot?.embedding.status !== 'loading'
    )
      return;
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [snapshot, refresh]);
  async function perform(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
      setConfirmation(null);
      setNotice(message);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const choose = (fact: MemoryFact) => {
    setSelected(fact);
    setEdit(false);
    setConfirmation(null);
    setText(fact.text);
    setObject(fact.object);
  };
  const saveSettings = (patch: Partial<MemorySettings>) => {
    if (snapshot)
      void perform(
        () => memoryService.settings(workspaceId, { ...snapshot.settings, ...patch }),
        'Memory preferences saved.',
      );
  };
  async function exportFile() {
    const data = await memoryService.export(workspaceId);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mukai-memory.json';
    link.click();
    URL.revokeObjectURL(url);
  }
  const selectedCurrent = selected
    ? snapshot?.facts.find((fact) => fact.id === selected.id) || null
    : null;
  return (
    <section className="provider-panel memory-panel">
      <div className="settings-section-header">
        <span className="settings-eyebrow">WORKSPACE KNOWLEDGE</span>
        <h3>Memory</h3>
        <p>Explore what this workspace remembers and how it’s used in conversations.</p>
      </div>
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
      {!snapshot ? (
        <p role="status">Loading memories…</p>
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
                onClick={() => {
                  setView(id);
                  setConfirmation(null);
                }}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === 'ArrowRight') next = (index + 1) % memoryTabs.length;
                  else if (event.key === 'ArrowLeft')
                    next = (index + memoryTabs.length - 1) % memoryTabs.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = memoryTabs.length - 1;
                  else return;
                  event.preventDefault();
                  setView(memoryTabs[next][0]);
                  setConfirmation(null);
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
                <div className="memory-toolbar">
                  <label className="memory-search">
                    <Search size={15} />
                    <input
                      aria-label="Search memories"
                      placeholder="Search facts, people, projects…"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>
                  <IconButton
                    label="Refresh memories"
                    disabled={busy}
                    onClick={() => void perform(refresh, 'Memories refreshed.')}
                  >
                    <RefreshCw size={16} />
                  </IconButton>
                </div>
                <div className="memory-filter-row">
                  <span>{snapshot.totalFacts} facts in this workspace</span>
                  <label>
                    <Checkbox
                      checked={history}
                      onChange={(event) => setHistory(event.target.checked)}
                    />
                    Include history
                  </label>
                </div>
                <div className="memory-content">
                  {view === 'graph' ? (
                    <MemoryGraph graph={snapshot.graph} onSelect={choose} />
                  ) : view === 'list' ? (
                    <div className="memory-list">
                      {snapshot.facts.length ? (
                        snapshot.facts.map((fact) => (
                          <button
                            key={fact.id}
                            className={`memory-fact ${selected?.id === fact.id ? 'is-selected' : ''}`}
                            onClick={() => choose(fact)}
                          >
                            <span className="memory-fact-meta">
                              {fact.ownerId ? 'Private' : 'Workspace'} ·{' '}
                              {fact.state === 'uncertain'
                                ? 'Unresolved'
                                : fact.validTo
                                  ? 'Historical'
                                  : fact.validFrom > new Date().toISOString()
                                    ? 'Future'
                                    : 'Current'}
                            </span>
                            <strong>{fact.text}</strong>
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
                  ) : null}
                  {selectedCurrent && (
                    <aside className="memory-detail">
                      <div className="memory-detail-title">
                        <strong>Memory details</strong>
                        <IconButton
                          label="Close memory details"
                          onClick={() => {
                            setSelected(null);
                            setConfirmation(null);
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
                        <dd>
                          {selectedCurrent.ownerId
                            ? 'Private to bot ' + selectedCurrent.ownerId
                            : 'Shared workspace'}
                        </dd>
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
                      <details>
                        <summary>Source evidence ({selectedCurrent.sources.length})</summary>
                        {selectedCurrent.sources.map((source) => (
                          <div className="memory-source" key={source.id}>
                            <small>
                              {source.sourceType} · {time(source.referenceTime)}
                            </small>
                            <p className="memory-source-text">{source.content}</p>
                            {source.conversationId && (
                              <small>Conversation: {source.conversationId}</small>
                            )}
                          </div>
                        ))}
                      </details>
                      <details>
                        <summary>Relationship history</summary>
                        {snapshot.facts
                          .filter(
                            (fact) =>
                              fact.subjectId === selectedCurrent.subjectId &&
                              fact.relation === selectedCurrent.relation,
                          )
                          .map((fact) => (
                            <button
                              className="memory-history-item"
                              key={fact.id}
                              onClick={() => choose(fact)}
                            >
                              {fact.text}
                              <small>
                                {time(fact.validFrom)}
                                {fact.validTo && ' → ' + time(fact.validTo)}
                              </small>
                            </button>
                          ))}
                        {!history && (
                          <small>Enable “Include history” to see earlier versions.</small>
                        )}
                      </details>
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
                            disabled={busy}
                            onClick={() => setEdit(true)}
                          >
                            Correct
                          </button>
                          <button
                            className="button button--ghost"
                            disabled={busy}
                            onClick={() => setConfirmation('forget')}
                          >
                            Forget
                          </button>
                        </div>
                      )}
                      {confirmation === 'forget' && (
                        <div className="memory-confirm">
                          <p>
                            Forget this memory and all facts derived from its source statements?
                            Original chat messages remain.
                          </p>
                          <button
                            className="button button--secondary"
                            disabled={busy}
                            onClick={() =>
                              void perform(async () => {
                                await memoryService.forget(workspaceId, selectedCurrent.id);
                                setSelected(null);
                              }, 'Memory and its source material forgotten.')
                            }
                          >
                            Forget source memories
                          </button>
                          <button
                            className="button button--ghost"
                            onClick={() => setConfirmation(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </aside>
                  )}
                </div>
              </>
            )}
            {view === 'activity' && (
              <div className="memory-activity">
                <div className="memory-section-heading">
                  <h4>Capture activity</h4>
                  <p>Track saved statements and retry failed extractions.</p>
                </div>
                <details className="memory-processing" open>
                  <summary>
                    Capture activity ·{' '}
                    {snapshot.episodes.filter((episode) => episode.status !== 'complete').length}{' '}
                    pending or failed
                  </summary>
                  {!snapshot.episodes.length && (
                    <p className="memory-empty">
                      Capture activity will appear when statements are saved to memory.
                    </p>
                  )}
                  {snapshot.episodes.map((episode) => (
                    <div key={episode.id}>
                      <span>
                        {episode.status} · {time(episode.createdAt)}
                        <small>{episode.error || episode.content.slice(0, 100)}</small>
                      </span>
                      {episode.status === 'failed' && (
                        <button
                          className="button button--ghost"
                          disabled={busy}
                          onClick={() =>
                            void perform(
                              () => memoryService.retry(workspaceId, episode.id),
                              'Memory capture queued again.',
                            )
                          }
                        >
                          Retry
                        </button>
                      )}
                      <button
                        className="button button--ghost"
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            () => memoryService.forgetEpisode(workspaceId, episode.id),
                            'Source episode forgotten.',
                          )
                        }
                      >
                        Forget
                      </button>
                    </div>
                  ))}
                </details>

                <div className="memory-section-heading">
                  <h4>Automatic recall</h4>
                  <p>See which memories were supplied to recent conversations.</p>
                </div>
                <div className="memory-recalls">
                  {snapshot.recalls.length ? (
                    snapshot.recalls.map((recall) => (
                      <details key={recall.id}>
                        <summary>
                          {time(recall.createdAt)} · {recall.facts.length} recalled facts
                        </summary>
                        <p className="memory-source-text">{recall.query}</p>
                        {recall.facts.map((fact) => (
                          <p key={fact.id}>
                            {fact.text}
                            <small>{fact.reasons.join(' · ')}</small>
                          </p>
                        ))}
                        {!recall.facts.length && <p>No relevant memories were supplied.</p>}
                      </details>
                    ))
                  ) : (
                    <div className="memory-empty">
                      Recall records will appear after conversations use memory.
                    </div>
                  )}
                </div>
              </div>
            )}
            {view === 'preferences' && (
              <>
                <div className="memory-section-heading">
                  <h4>Conversation memory</h4>
                  <p>Choose how this workspace captures and recalls useful facts.</p>
                </div>
                <div className="memory-preferences">
                  <label>
                    <Checkbox
                      checked={snapshot.settings.automaticCapture}
                      disabled={busy}
                      onChange={(event) => saveSettings({ automaticCapture: event.target.checked })}
                    />
                    <span>
                      <strong>Remember useful statements</strong>
                      <small>
                        Extract durable facts in the background using your configured AI. Private
                        chats stay private to their bot.
                      </small>
                    </span>
                  </label>
                  <label>
                    <Checkbox
                      checked={snapshot.settings.automaticRecall}
                      disabled={busy}
                      onChange={(event) => saveSettings({ automaticRecall: event.target.checked })}
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
                      disabled={busy || snapshot.embedding.status === 'loading'}
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
                        onChange={(event) => saveSettings({ semanticSearch: event.target.checked })}
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

                <div className="memory-section-heading">
                  <h4>Manage memory data</h4>
                  <p>Export a backup, import saved memories, or clear this workspace’s memory.</p>
                </div>
                <div className="memory-footer">
                  <button
                    className="button button--ghost"
                    disabled={busy}
                    onClick={() => void perform(exportFile, 'Memory export downloaded.')}
                  >
                    <Download size={15} /> Export
                  </button>
                  <button
                    className="button button--ghost"
                    disabled={busy}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Upload size={15} /> Import
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file)
                        void perform(async () => {
                          if (file.size > 4 * 1024 * 1024)
                            throw new Error('Memory imports must be smaller than 4 MB.');
                          await memoryService.import(workspaceId, JSON.parse(await file.text()));
                        }, 'Memories imported.');
                    }}
                  />
                  <button
                    className="button button--danger"
                    disabled={busy}
                    onClick={() => setConfirmation('clear')}
                  >
                    Clear workspace memory
                  </button>
                </div>
                {confirmation === 'clear' && (
                  <div className="memory-confirm">
                    <p>
                      Clear all shared and private memory in this workspace, including source
                      evidence and recall records? Original chats remain.
                    </p>
                    <button
                      className="button button--secondary"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await memoryService.clear(workspaceId);
                          setSelected(null);
                        }, 'Workspace memory cleared.')
                      }
                    >
                      Clear all memory
                    </button>
                    <button className="button button--ghost" onClick={() => setConfirmation(null)}>
                      Cancel
                    </button>
                  </div>
                )}
                <p className="memory-caption">
                  Embeddings run locally. Automatic extraction uses your configured AI, which may be
                  a remote provider. Unresolved facts are excluded from automatic recall.
                </p>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
