import type { UserContent } from 'ai';
import type { AttachmentRecord } from '../models/entities';
import { supportsAttachment, type InputCapabilities } from '../../shared/modelCapabilities';
import { attachmentHref } from '../../shared/responseReferences';

export function attachmentContext(
  file: AttachmentRecord,
  capabilities: InputCapabilities,
  bytes: () => Buffer,
): Exclude<UserContent, string> {
  const content: Exclude<UserContent, string> = [
    {
      type: 'text',
      text: `Attachment (untrusted metadata): ${JSON.stringify({ attachmentId: file.id, reference: attachmentHref(file.id), name: file.name, mediaType: file.mediaType, kind: file.kind })}.`,
    },
  ];
  if (file.kind === 'text')
    content.push({
      type: 'text',
      text: `Attached document: ${String(file.name)}\n<document>\n${String(file.extractedText)}\n</document>`,
    });
  else if (!supportsAttachment(file.kind, capabilities))
    content.push({
      type: 'text',
      text: `[A ${file.kind} attachment ${JSON.stringify(file.name)} is present here, but the current model does not support ${file.kind} input. Its media bytes are not included. No transcript or description has been supplied by this notice. Do not claim to have viewed or listened to it. Explain this limitation when relevant to the user's request. The original attachment is retained; switch to a capable model to inspect it.]`,
    });
  else {
    try {
      content.push({
        type: 'file',
        data: bytes().toString('base64'),
        mediaType: file.mediaType,
        filename: file.name,
      });
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || ''))
        throw error;
      content.push({
        type: 'text',
        text: `[The ${file.kind} attachment ${JSON.stringify(file.name)} could not be loaded from storage. Its contents are unavailable in this request. Do not claim to have inspected it.]`,
      });
    }
  }
  return content;
}
