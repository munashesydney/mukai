import type {
  ChatGPTSignIn,
  ProviderModel,
  ProviderInput,
  ProviderSettings,
  ProviderTestResult,
} from '../../../shared/ai';
import { api } from './http';

export const providerService = {
  models: (id: string) => api<ProviderModel[]>(`/providers/${encodeURIComponent(id)}/models`),
  beginChatGPT: async (providerId?: string, consent = false, retryAttemptId?: string) => {
    const result = await api<ChatGPTSignIn>('/providers/chatgpt-auth', 'POST', {
      providerId,
      consent,
      retryAttemptId,
    });
    if (result.url) {
      try {
        if (window.mukai) await window.mukai.openExternal(result.url);
        else {
          const popup = window.open(result.url, '_blank', 'noopener,noreferrer');
          // noopener browsers can return null even when opening succeeds; the UI also provides a link.
          void popup;
        }
      } catch (error) {
        await api(`/providers/chatgpt-auth/${result.id}`, 'DELETE');
        throw error;
      }
    }
    return result;
  },
  chatGPTStatus: (id: string) =>
    api<ChatGPTSignIn>(`/providers/chatgpt-auth/${encodeURIComponent(id)}`),
  cancelChatGPT: (id: string) => api(`/providers/chatgpt-auth/${encodeURIComponent(id)}`, 'DELETE'),
  disconnectChatGPT: (id: string) =>
    api<{ ok: boolean; message: string }>(
      `/providers/${encodeURIComponent(id)}/disconnect`,
      'POST',
    ),
  list: () => api<ProviderSettings[]>('/providers'),
  create: (value: ProviderInput) => api<ProviderSettings>('/providers', 'POST', value),
  update: (id: string, value: ProviderInput) =>
    api<ProviderSettings>(`/providers/${encodeURIComponent(id)}`, 'PUT', value),
  remove: (id: string) =>
    api<{ ok: boolean; message?: string }>(`/providers/${encodeURIComponent(id)}`, 'DELETE'),
  test: (id: string) =>
    api<ProviderTestResult>(`/providers/${encodeURIComponent(id)}/test`, 'POST'),
};
