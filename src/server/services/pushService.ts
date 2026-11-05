import type { PushRepository } from '../repositories/pushRepository';
import { relayOrigin, sendPush, type PushSender } from '../push/transport';

export class PushService {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private closed = false;
  constructor(
    private repository: PushRepository,
    private sender: PushSender = sendPush,
  ) {}
  configuration() {
    return {
      serverId: this.repository.serverId,
      relayUrl: process.env.MUKAI_PUSH_RELAY_URL || 'https://mukai-relay.munashesydney.com',
    };
  }
  start() {
    this.timer = setInterval(() => {
      void this.flush();
    }, 1000);
    this.timer.unref();
  }
  register(
    token: string,
    input: { installationId: string; relayUrl: string; deliveryToken: string },
  ) {
    this.repository.register(token, { ...input, relayUrl: relayOrigin(input.relayUrl) });
    return { registered: true, serverId: this.repository.serverId };
  }
  remove(token: string, id: string) {
    this.repository.remove(token, id);
    return { removed: true };
  }
  test(token: string) {
    const result = this.repository.test(token);
    void this.flush();
    return result;
  }
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = (async () => {
      for (const row of this.repository.pending()) {
        let status = 503;
        try {
          status = await this.sender(
            String(row.relay_url),
            String(row.device_id),
            this.repository.credential(String(row.credential)),
            JSON.parse(String(row.payload)) as Record<string, string>,
          );
        } catch {
          /* The durable outbox retries without exposing capabilities or payloads to logs. */
        }
        this.repository.result(
          String(row.id),
          String(row.device_id),
          status,
          Number(row.attempts) + 1,
        );
      }
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.running;
  }
}
