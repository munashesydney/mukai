import type { ChatMessage } from '../../shared/ai';
import type { ChatOutput } from '../services/chatService';
import type { TelegramJob } from './types';
import type { TelegramDeliveryQueue } from './delivery';

/** Only public answer text leaves Mukai. Reasoning and tool event payloads stay local. */
export class TelegramChatOutput implements ChatOutput {
  private text = '';
  private partId?: string;
  message?: ChatMessage;
  constructor(
    private job: TelegramJob,
    private delivery: TelegramDeliveryQueue,
    private approval: () => void,
  ) {}
  start() {
    this.delivery.draft(this.job, '');
  }
  emit: ChatOutput['emit'] = (event) => {
    if (event.type === 'delta') {
      if (event.partId && event.partId !== this.partId) {
        this.partId = event.partId;
        this.text = '';
      }
      this.text = (this.text + event.text).slice(-4000);
      this.delivery.draft(this.job, this.text);
    } else if (event.type === 'activity' || event.type === 'reasoning') {
      // Clear prior commentary while tools or reasoning run; do not forward their contents.
      this.text = '';
      this.delivery.draft(this.job, '');
    } else if (event.type === 'approval') this.approval();
    else if (event.type === 'done' || event.type === 'error') {
      this.message = event.message;
      this.delivery.end(this.job.id);
    }
  };
  onDisconnect() {
    return () => {};
  }
  end() {
    this.delivery.end(this.job.id);
  }
}
