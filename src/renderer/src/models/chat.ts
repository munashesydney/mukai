import type { Attachment, ChatMessage } from '../../../shared/ai';

// Renderer state adds UI concerns to the shared API contracts.
export interface ChatState {
  messages: ChatMessage[];
  loading: boolean;
  busy: boolean;
  error: string;
  text: string;
  files: Attachment[];
  uploading: boolean;
  requestId: string;
}
export interface ChatDraft {
  text: string;
  requestId: string;
}
