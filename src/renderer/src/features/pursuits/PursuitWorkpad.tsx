import { useEffect, useState } from 'react';
import {
  ClipboardList,
  Copy,
  ExternalLink,
  Download,
  ChevronRight,
  ListTodo,
  GitBranch,
  CircleAlert,
  Link2,
  StickyNote,
} from 'lucide-react';
import type { Bot, ChatMessage } from '../../../../shared/ai';
import {
  workpadEntryTypes,
  workpadTypeLabels,
  workpadStatusLabels,
  workpadStatuses,
  validWorkpadStatus,
  type WorkpadEntry,
  type WorkpadEntryType,
  type WorkpadStatus,
  type WorkpadLink,
  type WorkpadPage,
  type PursuitRun,
} from '../../../../shared/pursuits';
import { pursuitService } from '../../services/pursuitService';
import { artifactService } from '../../services/artifactService';
import { chatService } from '../../services/chatService';
import { MessageMarkdown } from '../ai/MessageMarkdown';
import { Modal } from '../../components/ui/Modal';
import { Dropdown } from '../../components/ui/Dropdown';
import { Checkbox } from '../../components/ui/Checkbox';
import { errorText } from '../../utils/errors';

const typeIcons = {
  work_item: ListTodo,
  decision: GitBranch,
  blocker: CircleAlert,
  reference: Link2,
  note: StickyNote,
};

export function PursuitWorkpad({
  id,
  bots,
  runs,
  onRun,
}: {
  id: string;
  bots: Bot[];
  runs: PursuitRun[];
  onRun: (id: string) => void;
}) {
  const [type, setType] = useState<WorkpadEntryType | ''>('');
  const [status, setStatus] = useState<WorkpadStatus | ''>('');
  const [archived, setArchived] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<WorkpadPage | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<WorkpadEntry | null>(null);
  const [conversation, setConversation] = useState<{
    title: string;
    messages: ChatMessage[];
  } | null>(null);
  useEffect(() => {
    let alive = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await pursuitService.workpad(id, {
          type: type || undefined,
          status: status || undefined,
          includeArchived: archived,
          offset,
        });
        if (alive) {
          if (offset > 0 && !value.entries.length) {
            setOffset(Math.floor(Math.max(0, value.total - 1) / 20) * 20);
            return;
          }
          setPage(value);
          setSelected((current) =>
            current ? value.entries.find((entry) => entry.id === current.id) || current : null,
          );
          setError('');
        }
      } catch (caught) {
        if (alive) setError(errorText(caught));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [id, type, status, archived, offset]);
  function reset() {
    setOffset(0);
    setPage(null);
  }
  async function openEntry(entryId: string) {
    try {
      setSelected(await pursuitService.workpadEntry(id, entryId));
    } catch (caught) {
      setError(errorText(caught));
    }
  }
  const entryBody = (entry: WorkpadEntry) => (
    <>
      <MessageMarkdown text={entry.content} />
      {!!entry.links.length && (
        <ul className="workpad-links" aria-label="References">
          {entry.links.map((link, index) => (
            <li key={index}>
              <WorkpadReference
                link={link}
                runs={runs}
                onRun={onRun}
                onEntry={(target) => void openEntry(target)}
                onConversation={(title, messages) => {
                  setSelected(null);
                  setConversation({ title, messages });
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="workpad-provenance">
        <span>
          Added by {bots.find((bot) => bot.id === entry.authorBotId)?.name || 'Unavailable bot'}
        </span>
        {entry.originRunId && (
          <button className="text-button" onClick={() => onRun(entry.originRunId!)}>
            Originating run <ExternalLink size={12} />
          </button>
        )}
        <time dateTime={entry.updatedAt}>Updated {new Date(entry.updatedAt).toLocaleString()}</time>
      </div>
    </>
  );
  return (
    <section className="pursuit-workpad" aria-label="Workpad">
      <div className="pursuit-section-heading">
        <h2>
          <ClipboardList size={20} /> Workpad
        </h2>
        <span>{page ? `${page.total} entries` : 'Loading…'}</span>
      </div>
      <p className="workpad-intro">
        Your bot’s working notes, decisions, and progress. Entries evolve as the pursuit moves
        forward.
      </p>
      <div className="workpad-filters">
        <div className="workpad-filter">
          <span>Type</span>
          <Dropdown
            label="Workpad entry type"
            value={type}
            onChange={(value) => {
              const nextType = value as WorkpadEntryType | '';
              setType(nextType);
              if (nextType && status && !validWorkpadStatus(nextType, status)) setStatus('');
              reset();
            }}
            options={[
              { value: '', label: 'All types' },
              ...workpadEntryTypes.map((value) => ({ value, label: workpadTypeLabels[value] })),
            ]}
          />
        </div>
        <div className="workpad-filter">
          <span>Status</span>
          <Dropdown
            label="Workpad entry status"
            value={status}
            onChange={(value) => {
              setStatus(value as WorkpadStatus | '');
              if (value === 'archived') setArchived(true);
              reset();
            }}
            options={[
              { value: '', label: 'All statuses' },
              ...workpadStatuses
                .filter((value) => !type || validWorkpadStatus(type, value))
                .map((value) => ({ value, label: workpadStatusLabels[value] })),
            ]}
          />
        </div>
        <label className="workpad-archive-toggle">
          <Checkbox
            checked={archived}
            onChange={(event) => {
              setArchived(event.target.checked);
              if (!event.target.checked && status === 'archived') setStatus('');
              reset();
            }}
          />{' '}
          Include archived
        </label>
        {(type || status || archived) && (
          <button
            className="text-button workpad-clear"
            onClick={() => {
              setType('');
              setStatus('');
              setArchived(false);
              reset();
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      {error && (
        <p className="ai-alert" role="alert">
          {error}{' '}
          <button
            className="text-button"
            onClick={() => {
              setError('');
              reset();
            }}
          >
            Try again
          </button>
        </p>
      )}
      {!page && !error && <p className="ai-caption">Loading Workpad…</p>}
      {page && !page.entries.length && (
        <div className="pursuit-empty-runs">
          <p>
            {type || status || archived || offset
              ? 'No entries match this view.'
              : 'A fresh page for this pursuit.'}
          </p>
          <small>
            Your bot can add useful work items, decisions, blockers, references, and notes as it
            works. Simple pursuits may not need entries.
          </small>
        </div>
      )}
      <div className="workpad-entries">
        {page?.entries.map((entry) => {
          const TypeIcon = typeIcons[entry.type];
          return (
            <details className={`workpad-entry workpad-entry--${entry.status}`} key={entry.id}>
              <summary>
                <ChevronRight className="workpad-chevron" size={17} aria-hidden="true" />
                <span className="workpad-entry-main">
                  <span className="workpad-type">
                    <TypeIcon size={13} aria-hidden="true" />
                    {workpadTypeLabels[entry.type]}
                  </span>
                  <strong>{entry.title}</strong>
                  <span className="workpad-excerpt">{entry.content.slice(0, 180)}</span>
                </span>
                <span className="workpad-status">{workpadStatusLabels[entry.status]}</span>
              </summary>
              <div className="workpad-entry-body">{entryBody(entry)}</div>
            </details>
          );
        })}
      </div>
      {page && (offset > 0 || page.nextOffset !== null) && (
        <div className="workpad-pagination">
          <button
            className="button"
            disabled={!offset}
            onClick={() => {
              setOffset(Math.max(0, offset - 20));
              setPage(null);
            }}
          >
            Previous
          </button>
          <span>
            {page.entries.length ? `${offset + 1}–${offset + page.entries.length}` : '0'} of{' '}
            {page.total}
          </span>
          <button
            className="button"
            disabled={page.nextOffset === null}
            onClick={() => {
              setOffset(page.nextOffset!);
              setPage(null);
            }}
          >
            Next
          </button>
        </div>
      )}
      {selected && (
        <Modal key={selected.id} title={selected.title} onClose={() => setSelected(null)}>
          <div className="workpad-entry-body">
            <p className="workpad-type">
              {workpadTypeLabels[selected.type]} · {workpadStatusLabels[selected.status]}
            </p>
            {entryBody(selected)}
          </div>
        </Modal>
      )}
      {conversation && (
        <Modal title={conversation.title} onClose={() => setConversation(null)}>
          <div className="workpad-conversation">
            {!conversation.messages.length && <p>No messages in this conversation.</p>}
            {conversation.messages.map((message) => (
              <article key={message.id}>
                <strong>{message.role === 'user' ? 'User' : message.authorName || 'Bot'}</strong>
                <MessageMarkdown text={message.content} />
              </article>
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}

function WorkpadReference({
  link,
  runs,
  onRun,
  onEntry,
  onConversation,
}: {
  link: WorkpadLink;
  runs: PursuitRun[];
  onRun: (id: string) => void;
  onEntry: (id: string) => void;
  onConversation: (title: string, messages: ChatMessage[]) => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  async function open() {
    setBusy(true);
    setError('');
    try {
      if (link.kind === 'conversation') {
        const run = runs.find((item) => item.conversationId === link.target);
        if (run) onRun(run.id);
        else onConversation(link.label, await chatService.history('space:' + link.target));
      } else if (link.kind === 'artifact') {
        const blob = await artifactService.blob(link.target),
          url = URL.createObjectURL(blob),
          anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = link.label;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        await navigator.clipboard.writeText(link.target);
        setCopied(true);
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {link.kind === 'url' ? (
        <a
          href={link.target}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            if (window.mukai) {
              event.preventDefault();
              void window.mukai
                .openExternal(link.target)
                .catch((caught) => setError(errorText(caught)));
            }
          }}
        >
          {link.label} <ExternalLink size={12} />
        </a>
      ) : (
        <button
          className="text-button"
          disabled={busy}
          title={link.kind === 'file' ? `Copy path: ${link.target}` : link.target}
          aria-label={
            link.kind === 'file'
              ? `Copy path: ${link.label}`
              : link.kind === 'artifact'
                ? `Download ${link.label}`
                : undefined
          }
          onClick={() => (link.kind === 'entry' ? onEntry(link.target) : void open())}
        >
          {link.label}{' '}
          {link.kind === 'file' ? (
            <Copy size={12} />
          ) : link.kind === 'artifact' ? (
            <Download size={12} />
          ) : (
            <ExternalLink size={12} />
          )}
          {copied && <span>Path copied</span>}
        </button>
      )}
      {(link.kind === 'file' || link.kind === 'url') && <small>{link.target}</small>}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
