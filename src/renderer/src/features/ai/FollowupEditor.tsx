import { useEffect, useRef, useState } from 'react';
import { ATTACHMENT_LIMIT, UPLOAD_LIMIT, type ChatFollowup } from '../../../../shared/ai';
import {
  acceptedAttachments,
  supportsAttachment,
  type InputCapabilities,
} from '../../../../shared/modelCapabilities';
import { attachmentService } from '../../services/attachmentService';
import { errorText } from '../../utils/errors';
import { AttachmentCard } from './AttachmentCard';
import { chatStore } from './chatStore';
import { useAttachmentInput } from './useAttachmentInput';

export function FollowupEditor({
  chatId,
  item,
  capabilities,
  allowAttachments = true,
  submitting,
  onDone,
}: {
  chatId: string;
  item: ChatFollowup;
  capabilities: InputCapabilities;
  allowAttachments?: boolean;
  submitting: boolean;
  onDone: () => void;
}) {
  const [text, setText] = useState(item.text);
  const [files, setFiles] = useState(item.attachments || []);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const unclaimed = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const uploads = unclaimed.current;
    return () => {
      mounted.current = false;
      for (const id of uploads) void attachmentService.remove(id).catch(() => {});
    };
  }, []);
  const blocked = files.some((file) => !supportsAttachment(file.kind, capabilities));
  const busy = uploading || submitting;
  const attachmentInput = useAttachmentInput({
    capabilities,
    disabled: busy || !allowAttachments,
    onUpload: upload,
  });
  async function upload(selected: File[]) {
    if (busy || !selected.length) return;
    if (files.length + selected.length > ATTACHMENT_LIMIT)
      return setError('Attach up to four files per message.');
    if (selected.some((file) => !file.size || file.size > UPLOAD_LIMIT))
      return setError('Each file must be between 1 byte and 10 MB.');
    setUploading(true);
    setError('');
    try {
      for (const file of selected) {
        const saved = await attachmentService.upload(chatId, file);
        if (!mounted.current) {
          await attachmentService.remove(saved.id);
          break;
        }
        unclaimed.current.add(saved.id);
        setFiles((previous) => [...previous, saved]);
      }
    } catch (caught) {
      if (mounted.current) setError(errorText(caught));
    } finally {
      if (mounted.current) setUploading(false);
    }
  }
  async function remove(id: string) {
    try {
      if (unclaimed.current.has(id)) {
        await attachmentService.remove(id);
        unclaimed.current.delete(id);
      }
      setFiles((previous) => previous.filter((file) => file.id !== id));
    } catch (caught) {
      setError(errorText(caught));
    }
  }
  return (
    <div
      className={`followup-edit${attachmentInput.dragging ? ' is-dragging-files' : ''}`}
      {...attachmentInput.dragProps}
    >
      <textarea
        aria-label="Edit queued message"
        autoFocus
        rows={2}
        maxLength={16000}
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onPaste={attachmentInput.onPaste}
      />
      {!!files.length && (
        <div className="ai-attachments">
          {files.map((file) => (
            <AttachmentCard
              key={file.id}
              attachment={file}
              onRemove={busy ? undefined : () => void remove(file.id)}
            />
          ))}
        </div>
      )}
      {(error || attachmentInput.error || blocked) && (
        <p className="followup-error" role="alert">
          {error ||
            attachmentInput.error ||
            'This model does not support these attachments. Remove them or choose a model that supports them.'}
        </p>
      )}
      <div className="followup-edit-actions">
        {allowAttachments && (
          <label className="text-button">
            {uploading ? 'Uploading…' : 'Attach files'}
            <input
              className="visually-hidden"
              type="file"
              multiple
              aria-label="Attach files to queued message"
              accept={acceptedAttachments(capabilities)}
              disabled={busy}
              onChange={(event) => {
                void attachmentInput.upload(Array.from(event.target.files || []));
                event.target.value = '';
              }}
            />
          </label>
        )}
        <button
          className="text-button"
          disabled={busy || blocked || (!text.trim() && !files.length)}
          onClick={async () => {
            if (
              await chatStore.followup(chatId, {
                action: 'edit',
                id: item.id,
                text: text.trim(),
                attachmentIds: files.map((file) => file.id),
              })
            ) {
              unclaimed.current.clear();
              onDone();
            }
          }}
        >
          Save
        </button>
        <button className="text-button" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
