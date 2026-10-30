import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { attachmentInputError, type InputCapabilities } from '../../../../shared/modelCapabilities';

/** Keep picker, paste, and drop behavior identical, including model restrictions. */
export function useAttachmentInput({
  capabilities,
  disabled,
  onUpload,
}: {
  capabilities: InputCapabilities;
  disabled: boolean;
  onUpload: (files: File[]) => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    setError('');
  }, [capabilities.supportsImages, capabilities.supportsAudio, capabilities.supportsVideo]);
  async function upload(files: File[]) {
    if (disabled || pending.current || !files.length) return;
    const problem = attachmentInputError(files, capabilities);
    setError(problem);
    if (problem) return;
    pending.current = true;
    try {
      await onUpload(files);
    } finally {
      pending.current = false;
    }
  }
  function isFileDrag(event: DragEvent) {
    return event.dataTransfer.types.includes('Files');
  }
  return {
    error,
    dragging,
    upload,
    onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
      const files = Array.from(event.clipboardData.files);
      if (!files.length) return;
      event.preventDefault();
      void upload(files);
    },
    dragProps: {
      onDragEnter(event: DragEvent<HTMLDivElement>) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current++;
        if (!disabled) setDragging(true);
      },
      onDragOver(event: DragEvent<HTMLDivElement>) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      },
      onDragLeave(event: DragEvent<HTMLDivElement>) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      },
      onDrop(event: DragEvent<HTMLDivElement>) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current = 0;
        setDragging(false);
        void upload(Array.from(event.dataTransfer.files));
      },
    },
  };
}
