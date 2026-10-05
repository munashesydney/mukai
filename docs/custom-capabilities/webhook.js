import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

/** Generic HMAC example. Adapt the header and signing format to your provider's protocol. */
export default {
  name: 'event_webhook',
  method: 'POST',
  path: '/custom/webhooks/events',
  auth: 'handler',
  requiredEnv: ['EVENT_WEBHOOK_SECRET'],
  async handle(request, context) {
    const expected = createHmac('sha256', context.env.EVENT_WEBHOOK_SECRET)
      .update(request.rawBody)
      .digest();
    const received = Buffer.from(String(request.headers['x-event-signature'] || ''), 'hex');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      return { status: 401, body: { error: 'Invalid signature' } };
    }
    const event = request.body;
    if (!event || typeof event.id !== 'string')
      return { status: 400, body: { error: 'Missing event ID' } };
    const accepted = await context.enqueue('events', event.id, event);
    return { status: 202, body: { received: true, duplicate: accepted.duplicate } };
  },
  async processJob(event, context) {
    // Do normal code work here; make external writes idempotent using event.id.
    // Only request a model run when needed:
    // await context.wakeBot(`Review verified event ${event.id}`);
    // Or select another permitted workspace bot:
    // await context.wakeBot(`Review verified event ${event.id}`, { botId: 'target-bot-id' });
    return { processed: event.id, workspaceId: context.workspaceId };
  },
};
