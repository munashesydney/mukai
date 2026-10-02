import { useState } from 'react';
import { ArrowRight, Check, FileText, Pause, Play, Target, Info } from 'lucide-react';
import { Modal } from '../../components/ui/Modal';
import { Avatar } from '../../components/ui/Avatar';
import { TriangleMark } from '../../components/ui/TriangleMark';
import type { DialogKind, Pursuit } from './types';
import { SettingsDialog } from '../settings/SettingsDialog';

export function WorkspaceDialogs({
  kind,
  pursuit,
  onClose,
  onCreateSpace,
  onCreatePursuit,
  onTogglePaused,
}: {
  kind: DialogKind;
  pursuit?: Pursuit;
  onClose: () => void;
  onCreateSpace: (name: string, description: string) => void;
  onCreatePursuit: (name: string, description: string) => void;
  onTogglePaused: (id: string) => void;
}) {
  if (kind === 'draft')
    return (
      <Modal title="A simpler setup guide" onClose={onClose}>
        <div className="draft-document">
          <div className="document-meta">
            <span className="draft-badge">Draft</span>
            <span>Prepared by Nova · Today</span>
            <FileText size={17} />
          </div>
          <h3>
            A good start.
            <br />
            In three simple steps.
          </h3>
          <p className="document-intro">A few minutes now. A lot less work later.</p>
          {[
            {
              title: 'Connect your Telegram account',
              text: 'Open Settings, choose Telegram, and follow the prompts to connect your account.',
            },
            {
              title: 'Choose what to copy',
              text: 'Pick the source channel and the destination. You can review the details before anything starts.',
            },
            {
              title: 'Make it yours',
              text: 'Adjust your preferences, run a test, and you’re ready. Start small—you can always add more.',
            },
          ].map((step, index) => (
            <div className="document-step" key={step.title}>
              <span>{index + 1}</span>
              <div>
                <h4>{step.title}</h4>
                <p>{step.text}</p>
              </div>
            </div>
          ))}
          <div className="document-note">
            <Info size={17} />
            <span>This is a sample draft for the Mukai UI preview.</span>
          </div>
        </div>
        <div className="modal-footer">
          <span>
            <Avatar person="nova" size="xs" /> A little less friction.
          </span>
          <button className="button button--primary" onClick={onClose}>
            Looks good <Check size={15} />
          </button>
        </div>
      </Modal>
    );
  if (kind === 'settings') return <SettingsDialog onClose={onClose} />;
  if (kind === 'create-space' || kind === 'create-pursuit')
    return (
      <CreateDialog
        type={kind === 'create-space' ? 'space' : 'pursuit'}
        onClose={onClose}
        onCreate={kind === 'create-space' ? onCreateSpace : onCreatePursuit}
      />
    );
  if (kind === 'create-bot')
    return (
      <Modal title="Meet your next bot" onClose={onClose}>
        <div className="bot-preview">
          <span className="preview-symbol">
            <TriangleMark />
          </span>
          <h3>A little more possibility.</h3>
          <p>
            Your workspace already has Atlas, Nova, and Scout. Custom bots will let you bring your
            own personalities and skills into the mix.
          </p>
          <div className="preview-label">Custom bots · Coming next</div>
        </div>
        <div className="modal-footer">
          <span>For now, get to know your crew.</span>
          <button className="button button--primary" onClick={onClose}>
            Back to the workspace <ArrowRight size={15} />
          </button>
        </div>
      </Modal>
    );
  if (kind === 'details')
    return (
      <Modal title={pursuit ? 'Pursuit details' : 'About this workspace'} onClose={onClose}>
        <div className="details-document">
          <span className="preview-symbol">
            <Target size={29} />
          </span>
          <h3>{pursuit?.name ?? 'A home for your next good idea.'}</h3>
          <p>
            {pursuit?.description ??
              'Mukai brings your spaces, pursuits, and bots together. A little intention, a little conversation, and a useful next step.'}
          </p>
          {pursuit && (
            <>
              <div className="details-stat">
                <span>Progress</span>
                <strong>{pursuit.progress}%</strong>
              </div>
              <div className="details-progress">
                <span style={{ width: `${pursuit.progress}%` }} />
              </div>
              <div className="details-stat">
                <span>Keeping things moving</span>
                <span className="details-bot">
                  <Avatar person={pursuit.bot} size="xs" />
                  {pursuit.bot[0].toUpperCase() + pursuit.bot.slice(1)}
                </span>
              </div>
              <div className="details-stat">
                <span>Status</span>
                <span className="status-label">{pursuit.paused ? 'Paused' : 'In motion'}</span>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <span>One step at a time.</span>
          {pursuit ? (
            <button
              className="button"
              onClick={() => {
                onTogglePaused(pursuit.id);
                onClose();
              }}
            >
              {pursuit.paused ? <Play size={15} /> : <Pause size={15} />}
              {pursuit.paused ? 'Resume pursuit' : 'Pause pursuit'}
            </button>
          ) : (
            <button className="button button--primary" onClick={onClose}>
              Got it
            </button>
          )}
        </div>
      </Modal>
    );
  return null;
}

function CreateDialog({
  type,
  onClose,
  onCreate,
}: {
  type: 'space' | 'pursuit';
  onClose: () => void;
  onCreate: (name: string, description: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <Modal title={`Create a ${type}`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) {
            onCreate(name.trim(), description.trim());
            onClose();
          }
        }}
      >
        <div className="create-form">
          <p>
            {type === 'space'
              ? 'Give your next idea a place to grow.'
              : 'What would you like to move toward? Atlas can keep the bigger picture in view.'}
          </p>
          <label>
            {type === 'space' ? 'Space name' : 'What’s the pursuit?'}
            <input
              autoFocus
              required
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={
                type === 'space' ? 'e.g. the-next-big-thing' : 'e.g. Launch my first product'
              }
            />
          </label>
          <label>
            A little context <span>(optional)</span>
            <textarea
              rows={3}
              maxLength={400}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What’s this about?"
            />
          </label>
        </div>
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={!name.trim()}>
            Create {type} <ArrowRight size={15} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
