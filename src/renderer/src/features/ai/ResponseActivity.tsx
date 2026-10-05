import { useContext, useState } from 'react';
import { ConversationNavigation } from './ConversationNavigation';
import {
  Brain,
  ChevronDown,
  FileText,
  LoaderCircle,
  CircleAlert,
  Search,
  Pencil,
  Target,
  Terminal,
  Globe,
  Check,
  Minimize2,
  MessageCircleQuestion,
} from 'lucide-react';
import type { ChatActivity, ChatMessage, ResponsePart } from '../../../../shared/ai';
import { formatWorkDuration, responsePresentation } from '../../../../shared/responseParts';
import { MessageMarkdown } from './MessageMarkdown';

const actionLabels: Record<string, string> = {
  create_directory: 'Created folder',
  write_file: 'Wrote',
  read_file: 'Read',
  patch: 'Edited',
  list: 'Listed',
  search_files: 'Searched',
  clarification: 'Answered question',
  approval: 'Reviewed approval',
};

function ActivitySpinner() {
  return (
    <span className="response-spinner">
      <LoaderCircle size={14} className="is-spinning" />
    </span>
  );
}

function ToolRow({ activity }: { activity: ChatActivity }) {
  const openConversation = useContext(ConversationNavigation);
  const pursuitLabels: Record<string, string> = {
    create: 'Created pursuit',
    update: 'Updated pursuit',
    list: 'Listed pursuits',
    pause: 'Paused pursuit',
    resume: 'Resumed pursuit',
    complete: 'Completed pursuit',
  };
  const Icon =
    activity.tool === 'ask'
      ? MessageCircleQuestion
      : activity.tool === 'terminal'
        ? Terminal
        : activity.tool === 'browser'
          ? Globe
          : activity.tool === 'manage_pursuit'
            ? Target
            : activity.action === 'search_files'
              ? Search
              : ['write_file', 'patch', 'create_directory'].includes(activity.action)
                ? Pencil
                : FileText;
  const running = activity.status === 'running';
  const problem = activity.status === 'failed' || activity.status === 'interrupted';
  return (
    <details className={`response-tool response-tool--${activity.status}`}>
      <summary>
        {running ? <ActivitySpinner /> : <Icon size={14} />}
        <span className="response-tool-label">
          {running
            ? `Running ${activity.action.replaceAll('_', ' ')}`
            : problem
              ? `${activity.status === 'failed' ? 'Failed' : 'Interrupted'}: ${activity.action.replaceAll('_', ' ')}`
              : (activity.tool === 'manage_pursuit'
                  ? pursuitLabels[activity.action]
                  : actionLabels[activity.action]) || activity.action.replaceAll('_', ' ')}{' '}
          <span className="response-tool-path" title={activity.path}>
            {activity.path}
          </span>
        </span>
        {problem && <CircleAlert size={13} aria-label={activity.status} />}
        {activity.delegation && openConversation && (
          <button
            type="button"
            className="text-button response-delegation-link"
            aria-label={`Open bot conversation with ${activity.delegation.botName}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openConversation(activity.delegation!.conversationId);
            }}
          >
            Open bot conversation
          </button>
        )}
        <ChevronDown size={13} className="response-chevron" />
      </summary>
      <div className="response-tool-detail">
        <small>
          {activity.tool.replaceAll('_', ' ')} · {activity.action} · {activity.status}
        </small>
        <p>
          {activity.summary ||
            (running ? 'Working in your workspace folder…' : 'Waiting for the operation result…')}
        </p>
      </div>
    </details>
  );
}

function ToolGroup({
  parts,
  message,
}: {
  parts: Extract<ResponsePart, { type: 'tool' }>[];
  message: ChatMessage;
}) {
  const [open, setOpen] = useState(message.status === 'streaming');
  const labels = new Set<string>();
  for (const part of parts) {
    const activity = message.activity?.find((item) => item.id === part.activityId);
    if (activity)
      labels.add(
        activity.status !== 'complete'
          ? `${activity.status === 'running' ? 'Running' : activity.status === 'failed' ? 'Failed' : 'Interrupted'} tools`
          : activity.tool === 'manage_pursuit'
            ? 'Managed pursuits'
            : activity.tool === 'terminal'
              ? 'Ran commands'
              : activity.tool === 'browser'
                ? 'Used browser'
                : ['write_file', 'patch'].includes(activity.action)
                  ? 'Edited files'
                  : activity.action === 'search_files'
                    ? 'Searched files'
                    : activity.action === 'read_file'
                      ? 'Read files'
                      : activity.action === 'create_directory'
                        ? 'Created folders'
                        : activity.action === 'list'
                          ? 'Listed folders'
                          : 'Used tools',
      );
  }
  return (
    <details
      className="response-tool-group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <FileText size={14} />
        <span>
          {[...labels].join(', ') || 'Calling tools'} · {parts.length}
        </span>
        <ChevronDown size={13} className="response-chevron" />
      </summary>
      <div className="response-tool-group-content">
        {parts.map((part) => (
          <ToolPart key={part.id} part={part} message={message} />
        ))}
      </div>
    </details>
  );
}

function ToolPart({
  part,
  message,
}: {
  part: Extract<ResponsePart, { type: 'tool' }>;
  message: ChatMessage;
}) {
  const activity = message.activity?.find((item) => item.id === part.activityId);
  return activity ? (
    <ToolRow activity={activity} />
  ) : (
    <div className="response-tool-pending">
      {message.status === 'streaming' && <ActivitySpinner />}
      {message.status === 'streaming' ? 'Calling tool…' : 'Tool result unavailable.'}
    </div>
  );
}

function ReasoningPart({
  part,
  active,
}: {
  part: Extract<ResponsePart, { type: 'reasoning' }>;
  active: boolean;
}) {
  const [open, setOpen] = useState(active);
  return (
    <details
      className="response-reasoning"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {active ? <ActivitySpinner /> : <Brain size={14} />}
        <span>{active ? 'Thinking' : 'Reasoning'}</span>
        <ChevronDown size={13} className="response-chevron" />
      </summary>
      <div className="response-reasoning-detail">
        <MessageMarkdown text={part.text} />
      </div>
    </details>
  );
}

function CompactionPart({
  part,
  streaming,
}: {
  part: Extract<ResponsePart, { type: 'compaction' }>;
  streaming: boolean;
}) {
  const state = part.state === 'compacting' && !streaming ? 'interrupted' : part.state;
  const label =
    state === 'compacting'
      ? 'Compacting context…'
      : state === 'complete'
        ? 'Context compacted'
        : state === 'failed'
          ? 'Context compaction failed'
          : 'Context compaction interrupted';
  const Icon = state === 'compacting' ? LoaderCircle : state === 'complete' ? Check : CircleAlert;
  const detail =
    state === 'complete' && part.tokensAfter !== undefined
      ? `${part.tokensBefore.toLocaleString()} → ${part.tokensAfter.toLocaleString()} estimated context tokens. Original messages are kept.`
      : state === 'compacting'
        ? 'Preserving working memory before continuing. Original messages are kept.'
        : 'Original messages are kept. Retry to resume.';
  return (
    <div
      className={`response-compaction response-compaction--${state}`}
      role="status"
      title={detail}
    >
      <span>
        <Minimize2 size={13} aria-hidden="true" />
        <span>{label}</span>
        <Icon
          size={13}
          aria-hidden="true"
          className={state === 'compacting' ? 'is-spinning' : undefined}
        />
      </span>
    </div>
  );
}

function ProcessTranscript({ parts, message }: { parts: ResponsePart[]; message: ChatMessage }) {
  const groups: ResponsePart[][] = [];
  for (const part of parts) {
    const previous = groups.at(-1);
    if (part.type === 'tool' && previous?.[0].type === 'tool') previous.push(part);
    else groups.push([part]);
  }
  return (
    <div className="response-transcript" aria-label="Response activity">
      {groups.map((group) => {
        const part = group[0];
        if (part.type === 'text') return <MessageMarkdown key={part.id} text={part.text} />;
        if (part.type === 'compaction')
          return (
            <CompactionPart key={part.id} part={part} streaming={message.status === 'streaming'} />
          );
        if (part.type === 'reasoning') {
          const active =
            message.status === 'streaming' &&
            (part.state === 'streaming' || (!part.state && parts.at(-1)?.id === part.id));
          // Reset the disclosure once on completion; manual toggles persist while text streams.
          return <ReasoningPart key={`${part.id}:${active}`} part={part} active={active} />;
        }
        const tools = group.filter((item) => item.type === 'tool');
        return tools.length > 1 ? (
          <ToolGroup key={part.id} parts={tools} message={message} />
        ) : (
          <ToolPart key={part.id} part={part} message={message} />
        );
      })}
    </div>
  );
}

function CompletedProcess({ parts, message }: { parts: ResponsePart[]; message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const duration = formatWorkDuration(message.startedAt, message.finishedAt);
  const label =
    message.status === 'complete'
      ? 'Worked'
      : message.status === 'stopped'
        ? 'Stopped'
        : message.status === 'failed'
          ? 'Failed'
          : 'Interrupted';
  return (
    <details
      className="response-work"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>
          {label}
          {duration ? ` for ${duration}` : ''}
        </span>
        <ChevronDown size={13} className="response-chevron" />
      </summary>
      <ProcessTranscript parts={parts} message={message} />
    </details>
  );
}

export function ResponseActivity({ message }: { message: ChatMessage }) {
  const { process, answer } = responsePresentation(message);
  return (
    <>
      {!!process.length &&
        (message.status === 'streaming' ? (
          <ProcessTranscript parts={process} message={message} />
        ) : (
          <CompletedProcess
            key={`${message.id}:${message.startedAt || ''}`}
            parts={process}
            message={message}
          />
        ))}
      {!!answer && <MessageMarkdown text={answer} />}
    </>
  );
}
