import type { Attachment, ChatMessage, ChatFollowup } from '../../../shared/ai';

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
  followups: ChatFollowup[];
  submittingFollowup: boolean;
}
export interface ChatDraft {
  text: string;
  requestId: string;
}
