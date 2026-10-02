import { Activity, ArrowUpRight, FileText, Target } from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import type { Message, DialogKind } from '../workspace/types';
import { MessageFeed } from './MessageFeed';

export function FilesView({
  messages,
  onDialog,
}: {
  messages: Message[];
  onDialog: (dialog: DialogKind) => void;
}) {
  const attachments = messages.filter((m) => m.attachment);
  return (
    <div className="alternate-view">
      <div className="view-intro">
        <FileText size={24} />
        <h2>A home for the useful things.</h2>
        <p>Drafts and files shared in this conversation.</p>
      </div>
      <button className="file-list-row" onClick={() => onDialog('draft')}>
        <span className="card-symbol card-symbol--purple">
          <FileText size={24} />
        </span>
        <span>
          <strong>A simpler setup guide</strong>
          <small>Sample draft · Nova · 3 steps</small>
        </span>
        <span className="draft-badge">Draft</span>
        <ArrowUpRight size={18} />
      </button>
      {attachments.map((m) => (
        <div className="file-list-row" key={m.id}>
          <span className="card-symbol">
            <FileText size={22} />
          </span>
          <span>
            <strong>{m.attachment}</strong>
            <small>Filename preview · Munashe · {m.time}</small>
          </span>
          <span className="local-badge">Local</span>
        </div>
      ))}
    </div>
  );
}
export function ActivityView({
  onPursuit,
  onDraft,
}: {
  onPursuit: () => void;
  onDraft: () => void;
}) {
  return (
    <div className="alternate-view">
      <div className="view-intro">
        <Activity size={24} />
        <h2>A little progress adds up.</h2>
        <p>A snapshot of today’s workspace activity.</p>
      </div>
      <div className="activity-date">TODAY</div>
      <div className="activity-item">
        <Avatar person="nova" />
        <div>
          <strong>Nova shared a draft</strong>
          <p>A simpler setup guide, in just three steps.</p>
          <button onClick={onDraft}>
            Take a look <ArrowUpRight size={13} />
          </button>
        </div>
        <time>10:28 AM</time>
      </div>
      <div className="activity-item">
        <Avatar person="atlas" />
        <div>
          <strong>Atlas picked up a pursuit</strong>
          <p>A clearer path to $2,000 MRR.</p>
          <button onClick={onPursuit}>
            <Target size={13} /> View pursuit <ArrowUpRight size={13} />
          </button>
        </div>
        <time>10:15 AM</time>
      </div>
    </div>
  );
}
export function SavedView({
  messages,
  onDialog,
  onClose,
  bookmarks,
  onBookmark,
  reactions,
  onReact,
  onPursuit,
}: {
  messages: Message[];
  onDialog: (dialog: DialogKind) => void;
  onClose: () => void;
  bookmarks: string[];
  onBookmark: (id: string) => void;
  reactions: string[];
  onReact: (id: string) => void;
  onPursuit: () => void;
}) {
  return (
    <div className="saved-view">
      <div className="saved-view-heading">
        <h2>Saved for later</h2>
        <button className="button button--small" onClick={onClose}>
          Back to messages
        </button>
      </div>
      <MessageFeed
        messages={messages.filter((m) => bookmarks.includes(m.id))}
        onDialog={onDialog}
        bookmarks={bookmarks}
        onBookmark={onBookmark}
        reactions={reactions}
        onReact={onReact}
        onPursuit={onPursuit}
      />
    </div>
  );
}
