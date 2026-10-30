import { memo, useContext, useEffect, useState } from 'react';
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
  Image,
  Check,
  Minimize2,
  MessageCircleQuestion,
  Headphones,
  Video,
} from 'lucide-react';
import type { ChatActivity, ChatMessage, ResponsePart } from '../../../../shared/ai';
import { formatWorkDuration, responsePresentation } from '../../../../shared/responseParts';
import { MessageMarkdown } from './MessageMarkdown';
import { AttachmentCard } from './AttachmentCard';
import { ToolImagePreview } from './ToolImagePreview';
import { ResponseReferenceContext } from './responseReferenceContext';
import { TerminalCard } from './TerminalCard';
import { SpawnedBots } from './SpawnedBots';
import { responseStatus } from './responseStatus';
import { mediaActivityKind, toolGroupLabel } from './toolGroupLabel';
import { useWorkDisclosure } from './useWorkDisclosure';

const actionLabels: Record<string, string> = {
  create_directory: 'Created folder',
  copy_attachment: 'Copied attachment to',
  write_file: 'Wrote',
  read_file: 'Read',
  patch: 'Edited',
  list: 'Listed',
  search_files: 'Searched',
  clarification: 'Answered question',
  approval: 'Reviewed approval',
  read_image: 'Read image metadata',
  view_image: 'Viewed image',
  read_audio: 'Read audio metadata',
  listen_audio: 'Listened to audio',
  read_video: 'Read video metadata',
  view_video: 'Viewed video',
  receive_message: 'Reply from',
  wait_for_bots: 'Waited for delegated bots',
};

function ActivitySpinner() {
  return (
    <span className="response-spinner">
      <LoaderCircle size={14} className="is-spinning" />
    </span>
  );
}

function ToolRow({ activity, message }: { activity: ChatActivity; message: ChatMessage }) {
  const [preview, setPreview] = useState(false);
  let artifactId = '';
  if (activity.action === 'screenshot' && ['browser', 'computer_use'].includes(activity.tool)) {
    try {
      const summary = JSON.parse(activity.summary);
      if (typeof summary.artifactId === 'string') artifactId = summary.artifactId;
    } catch {
      /* Older or truncated results still have their diagnostic disclosure. */
    }
  }
  const isImage =
    activity.status === 'complete' &&
    (Boolean(artifactId) ||
      (activity.tool === 'image' && activity.action === 'view') ||
      (activity.tool === 'media' && activity.action === 'view_image'));

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
      : activity.tool === 'image' || activity.tool === 'media'
        ? activity.action.includes('audio')
          ? Headphones
          : activity.action.includes('video')
            ? Video
            : Image
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
  const label = (
    <>
      {running ? <ActivitySpinner /> : <Icon size={14} />}
      <span className="response-tool-label">
        {running
          ? activity.action === 'wait_for_bots'
            ? 'Waiting for delegated bots'
            : `Running ${activity.action.replaceAll('_', ' ')}`
          : problem
            ? `${activity.status === 'failed' ? 'Failed' : 'Interrupted'}: ${activity.action.replaceAll('_', ' ')}`
            : (activity.tool === 'image'
                ? activity.action === 'view'
                  ? 'Viewed image'
                  : 'Read image metadata'
                : activity.tool === 'manage_pursuit'
                  ? pursuitLabels[activity.action]
                  : actionLabels[activity.action]) || activity.action.replaceAll('_', ' ')}{' '}
        <span className="response-tool-path" title={activity.path}>
          {activity.path}
        </span>
      </span>
      {activity.action === 'receive_message' && (
        <span className="response-bot-preview">{activity.summary.slice(0, 140)}</span>
      )}
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
    </>
  );
  if (isImage)
    return (
      <div className="response-tool">
        <button type="button" className="response-tool-image" onClick={() => setPreview(true)}>
          {label}
        </button>
        {preview && (
          <ToolImagePreview
            activity={activity}
            message={message}
            artifactId={artifactId}
            onClose={() => setPreview(false)}
          />
        )}
      </div>
    );
  return (
    <details
      className={`response-tool response-tool--${activity.status}${activity.action === 'receive_message' ? ' response-tool--reply' : ''}`}
    >
      <summary>
        {label}
        <ChevronDown size={13} className="response-chevron" />
      </summary>
      <div className="response-tool-detail">
        <small>
          {activity.action === 'receive_message' ? (
            `${activity.path} · Reply`
          ) : (
            <>
              {activity.tool.replaceAll('_', ' ')} · {activity.action} · {activity.status}
            </>
          )}
        </small>
        {activity.action === 'receive_message' ? (
          <MessageMarkdown text={activity.summary} />
        ) : (
          <p>
            {activity.summary ||
              (running ? 'Working in your workspace folder…' : 'Waiting for the operation result…')}
          </p>
        )}
      </div>
    </details>
  );
}

function ToolGroup({
  parts,
  message,
  active,
}: {
  parts: Extract<ResponsePart, { type: 'tool' | 'reasoning' }>[];
  message: ChatMessage;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tools = parts.filter((part) => part.type === 'tool');
  const activities = tools.flatMap((part) => {
    const activity = message.activity?.find((item) => item.id === part.activityId);
    return activity ? [activity] : [];
  });
  const label = tools.length
    ? toolGroupLabel(activities, active)
    : active
      ? 'Thinking'
      : 'Reasoned';
  const problems = activities.filter((item) => ['failed', 'interrupted'].includes(item.status));
  const media = mediaActivityKind(activities[0]);
  const Icon = problems.length
    ? CircleAlert
    : media === 'image'
      ? Image
      : media === 'audio'
        ? Headphones
        : media === 'video'
          ? Video
          : tools.length
            ? FileText
            : Brain;
  const sessions = new Set<string>();
  return (
    <details
      className="response-tool-group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        title={
          tools.length
            ? `${label} · ${tools.length} tool ${tools.length === 1 ? 'call' : 'calls'}`
            : label
        }
      >
        <Icon size={14} />
        <span
          className={`response-tool-group-label${active ? ' is-working' : ''}`}
          role={active ? 'status' : undefined}
        >
          {label}
        </span>
        {!!problems.length && (
          <span className="response-tool-group-problems">· {problems.length} unsuccessful</span>
        )}
        <ChevronDown size={13} className="response-chevron" />
      </summary>
      <div
        className="response-tool-group-content"
        role="region"
        tabIndex={0}
        aria-label="Tool calls"
      >
        {parts.map((part) => {
          if (part.type === 'reasoning')
            return (
              <ReasoningPart
                key={`${part.id}:${active && part.state === 'streaming'}`}
                part={part}
                active={active && part.state === 'streaming'}
              />
            );
          const activity = activities.find((item) => item.id === part.activityId);
          const sessionId = activity?.processSessionId || activity?.terminal?.id;
          if (activity?.tool === 'terminal' && sessionId) {
            if (sessions.has(sessionId)) return null;
            sessions.add(sessionId);
          }
          return <ToolPart key={part.id} part={part} message={message} />;
        })}
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
  if (activity?.tool === 'terminal' && activity.action !== 'list') {
    const sessionId = activity.processSessionId || activity.terminal?.id;
    const latest = sessionId
      ? [...(message.activity || [])]
          .reverse()
          .find(
            (item) =>
              item.tool === 'terminal' &&
              (item.processSessionId || item.terminal?.id) === sessionId &&
              item.terminal,
          )
      : undefined;
    return (
      <TerminalCard activity={latest ? { ...activity, terminal: latest.terminal } : activity} />
    );
  }
  return activity ? (
    <ToolRow activity={activity} message={message} />
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
        <Brain size={14} />
        <span className={active ? 'response-shimmer' : undefined}>
          {active ? 'Thinking' : 'Reasoning'}
        </span>
        <ChevronDown size={13} className="response-chevron" />
      </summary>
      <div className="response-reasoning-detail">
        <MessageMarkdown text={part.text} streaming={active} />
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

function ProcessTranscript({
  parts,
  message,
  continuing,
}: {
  parts: ResponsePart[];
  message: ChatMessage;
  continuing: boolean;
}) {
  const groups: ResponsePart[][] = [];
  const activities = new Map(message.activity?.map((activity) => [activity.id, activity]));
  const isWork = (part: ResponsePart) => part.type === 'tool' || part.type === 'reasoning';
  const mediaKind = (part: ResponsePart) =>
    part.type === 'tool' ? mediaActivityKind(activities.get(part.activityId)) : undefined;
  for (const part of parts) {
    const previous = groups.at(-1);
    const previousTool = previous?.find((item) => item.type === 'tool');
    if (
      isWork(part) &&
      previous &&
      isWork(previous[0]) &&
      (part.type === 'reasoning' ||
        !previousTool ||
        mediaKind(part) === mediaKind(previousTool) ||
        (part.type === 'tool' && !activities.has(part.activityId)))
    )
      previous.push(part);
    else groups.push([part]);
  }
  // Keep the initial Thinking disclosure in the same slot as the first work
  // group, so it can gain reasoning and tool calls without changing its identity.
  if (!groups.length && continuing) groups.push([]);
  return (
    <div className="response-transcript" aria-label="Response activity">
      {groups.map((group, index) => {
        const part = group[0];
        if (!part || isWork(part)) {
          const work = group.filter((item) => item.type === 'tool' || item.type === 'reasoning');
          const running = work.some(
            (item) =>
              item.type === 'tool' &&
              message.activity?.some(
                (activity) => activity.id === item.activityId && activity.status === 'running',
              ),
          );
          return (
            <ToolGroup
              key={`${index === 0 ? 'initial-work' : part.id}:${message.status === 'streaming' ? 'streaming' : 'finished'}`}
              parts={work}
              message={message}
              active={continuing && (index === groups.length - 1 || running)}
            />
          );
        }
        if (part.type === 'steering')
          return (
            <div key={part.id} className="response-steering">
              <span>You steered this task</span>
              <p>{part.text}</p>
              {!!part.attachments?.length && (
                <div className="ai-attachments">
                  {part.attachments.map((file) => (
                    <AttachmentCard key={file.id} attachment={file} />
                  ))}
                </div>
              )}
            </div>
          );
        if (part.type === 'text')
          return (
            <MessageMarkdown
              key={part.id}
              text={part.text}
              streaming={message.status === 'streaming'}
            />
          );
        if (part.type === 'compaction')
          return (
            <CompactionPart key={part.id} part={part} streaming={message.status === 'streaming'} />
          );
        return null;
      })}
    </div>
  );
}

function WorkProcess({
  parts,
  message,
  expanded,
  onExpandedChange,
  answerStarted,
}: {
  parts: ResponsePart[];
  message: ChatMessage;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  answerStarted: boolean;
}) {
  const { workExpanded: internalOpen, onWorkExpandedChange: setOpen } = useWorkDisclosure(message);
  const [now, setNow] = useState(() => Date.now());
  const streaming = message.status === 'streaming';
  useEffect(() => {
    if (!streaming) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [streaming]);
  const open = expanded ?? internalOpen;
  const duration = formatWorkDuration(
    message.startedAt || (streaming ? message.createdAt : undefined),
    streaming ? new Date(now).toISOString() : message.finishedAt,
  );
  const label = streaming
    ? 'Working'
    : message.status === 'complete'
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
      onToggle={(event) => (onExpandedChange || setOpen)(event.currentTarget.open)}
    >
      <summary>
        <span>
          {label}
          {duration ? ` for ${duration}` : ''}
        </span>
        <ChevronDown size={13} className="response-chevron" />
      </summary>
      <ProcessTranscript parts={parts} message={message} continuing={streaming && !answerStarted} />
      {streaming && !answerStarted && parts.at(-1)?.type === 'text' && (
        <ResponseLoading message={message} />
      )}
    </details>
  );
}

function ResponseLoading({ message }: { message: ChatMessage }) {
  return (
    <div className="ai-response-status" role="status">
      <span className="response-shimmer">{responseStatus(message)}</span>
    </div>
  );
}

export const ResponseActivity = memo(function ResponseActivity({
  message,
  workExpanded,
  onWorkExpandedChange,
}: {
  message: ChatMessage;
  workExpanded?: boolean;
  onWorkExpandedChange?: (open: boolean) => void;
}) {
  const { process, answer } = responsePresentation(message);
  // Providers can emit separator newlines on otherwise tool-only steps. They
  // are not commentary boundaries and must not split one tool loop into rows.
  const visibleProcess = process.filter((part) => part.type !== 'text' || part.text.trim());
  const hasAnswer = Boolean(answer.trim());
  return (
    <ResponseReferenceContext.Provider value={message.conversationId || 'bot-' + message.botId}>
      {(!!visibleProcess.length || message.status === 'streaming') && (
        <WorkProcess
          key={`${message.id}:${message.startedAt || ''}`}
          parts={visibleProcess}
          message={message}
          expanded={workExpanded}
          onExpandedChange={onWorkExpandedChange}
          answerStarted={hasAnswer}
        />
      )}
      {hasAnswer && (
        <MessageMarkdown text={answer} streaming={message.status === 'streaming'} imageGallery />
      )}
      {hasAnswer && message.status === 'streaming' && <ResponseLoading message={message} />}
      <SpawnedBots message={message} />
    </ResponseReferenceContext.Provider>
  );
});
