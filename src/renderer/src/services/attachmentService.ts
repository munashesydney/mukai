import type { Attachment } from '../../../shared/ai';
import { api, apiFetch } from './http';
import { chatRoot } from './chatTarget';

export const attachmentService = {
  pending: (id: string) => api<Attachment[]>(`${chatRoot(id)}/attachments`),
  sent: (botId: string) => api<Attachment[]>(`/bots/${encodeURIComponent(botId)}/files`),
  async upload(botId: string, file: File): Promise<Attachment> {
    const response = await apiFetch(`${chatRoot(botId)}/attachments`, {
      method: 'POST',
      headers: {
        'X-Filename': encodeURIComponent(file.name),
        'Content-Type': 'application/octet-stream',
      },
      body: file,
    });
    return response.json() as Promise<Attachment>;
  },
  remove: (id: string) => api<{ ok: boolean }>(`/attachments/${encodeURIComponent(id)}`, 'DELETE'),
  async blob(id: string) {
    return (await apiFetch(`/attachments/${encodeURIComponent(id)}`)).blob();
  },
};
