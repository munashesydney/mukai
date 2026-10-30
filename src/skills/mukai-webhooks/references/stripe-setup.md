# Stripe invoice notification example

This example consumes invoice.paid **snapshot events** and asks an existing workspace bot to report the notification. It does not charge, refund or fulfill anything. Thin notifications have a different contract; use the corresponding Stripe parser and data retrieval when building a thin-event integration.

## Workspace setup

1. Select the actual target bot ID with its allowed workspace/hierarchy access. Save STRIPE_BOT_ID as a Configuration variable in Settings → Environment Variables.
2. Save the matching endpoint's whsec_ signing secret as Secret under STRIPE_WEBHOOK_SECRET. This is not the Stripe API key. The CLI listener and Dashboard endpoint use different signing secrets; use the one that produced the delivery.
3. In the workspace terminal run npm install stripe. Copy references/stripe-webhook.js into a workspace file such as webhooks/stripe.js, then call register_custom_route with {operation:'register',modulePath:'webhooks/stripe.js'}. Install dependencies inside the VM for a VM workspace. Registering does not execute a delivery.
4. Keep Mukai and the workspace runtime available. Check status/missingEnv before testing. Bot-owned registrations follow the owner's wake permissions; ownerless registrations still need the configured target ID. The target comes from workspace configuration, never from Stripe metadata.

## Local test delivery

After setting up Stripe CLI access to a test/sandbox account, run this in a terminal on the appropriate computer:

```sh
stripe listen --events invoice.paid --forward-to "$MUKAI_ROUTES_URL/custom/stripe-events"
```

MUKAI_ROUTES_URL contains the real listener port and the VM gateway when applicable. No Mukai bearer header is needed: the handler checks Stripe's signature. Save the whsec_ secret printed by this listener in Settings; do not put it into chat, code or command arguments. With those values configured, trigger a test invoice.paid event with Stripe CLI or the test Dashboard. Check Stripe delivery status, the custom-route run/queue history, and the target bot's resulting conversation.

## Public delivery

Configure an HTTPS proxy/tunnel to the running backend and save its public origin in Settings → Domain. Register that exact HTTPS /custom/stripe-events URL with Stripe, subscribe to invoice.paid snapshot events, and save that endpoint's signing secret. The domain setting does not create a tunnel. Signature verification uses the original bytes supplied as request.rawBody; avoid body rewriting by intermediaries.

## Reliability

The module checks the signature before filtering event types or enqueueing. Awaiting enqueue persists and deduplicates this registration/provider/event ID before returning 200; persistence errors must fail the request so delivery can retry. Unsupported verified event types return 200 without work. The background payload contains invoice metadata and a trusted target ID, not credentials or arbitrary customer text.

processJob calls wakeBot, which durably queues a model wake; accepted does not mean the model completed. Inspect both the processing job and the bot conversation. Queued processing can retry, delivery order is not guaranteed, and distinct Stripe events can describe the same business object. For later state-changing integrations, add durable business-level idempotency and retrieve current Stripe state where required. A notification is not authorization for payment actions.

Sources checked 2026-10-30: [Stripe webhooks](https://docs.stripe.com/webhooks), [signature verification and delivery handling](https://docs.stripe.com/events/manage-webhook-endpoints), [Stripe CLI listen](https://docs.stripe.com/cli/listen), and [Stripe Node SDK webhook implementation](https://github.com/stripe/stripe-node/blob/master/src/Webhooks.ts). Recheck Stripe's current documentation when adapting the example.
