import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { startApiServer } from '../src/server/app';
import type { ResponsePart } from '../src/shared/ai';

// Exercise the actual React forms and context meter without calling an AI provider.
export async function checkContextPanel(
  window: BrowserWindow,
  api: Awaited<ReturnType<typeof startApiServer>>,
) {
  const evaluate = async <T>(code: string): Promise<T> => {
    const result = await window.webContents.executeJavaScript(
      `(() => { try { return (${code}); } catch (error) { return {__smokeError:error.message}; } })()`,
    );
    if (result && typeof result === 'object' && '__smokeError' in result)
      throw new Error(`Context panel: ${result.__smokeError}; script: ${code}`);
    return result;
  };
  const wait = async (code: string, name: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate<boolean>(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(name + ' did not settle');
  };
  await wait('Boolean(document.querySelector(".context-meter"))', 'composer context meter');
  assert.match(
    await evaluate<string>('document.querySelector(".context-meter").textContent'),
    /unknown/,
  );
  await evaluate('document.querySelector(".ai-configure-link").click()');
  await wait('Boolean(document.querySelector(".provider-empty"))', 'provider settings');
  await evaluate(
    'Array.from(document.querySelectorAll(".provider-panel button")).find(el=>el.textContent.trim()==="Add provider").click()',
  );
  await wait('Boolean(document.querySelector(".provider-panel form"))', 'provider form');
  const fill = (selector: string, label: string, value: string) =>
    evaluate(`(() => {
    const el=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.textContent.includes(${JSON.stringify(label)})).querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await fill('.provider-panel label', 'API key', 'test-key-never-used');
  assert.equal(
    await evaluate<boolean>('document.querySelector(".provider-panel form").checkValidity()'),
    false,
  );
  await fill('.provider-panel label', 'Context window (tokens)', '65536');
  await fill('.provider-panel label', 'Maximum output (tokens)', '4096');
  assert.equal(
    await evaluate<boolean>('document.querySelector(".provider-panel form").checkValidity()'),
    true,
  );
  await evaluate('document.querySelector(".provider-panel form").requestSubmit()');
  await wait(
    'Boolean(document.querySelector(".provider-card")) && !document.querySelector(".provider-panel form")',
    'saved provider',
  );
  assert.equal(
    api.store.get('SELECT context_window_tokens FROM providers')?.context_window_tokens,
    65536,
  );
  await evaluate(
    'Array.from(document.querySelectorAll(".rail-link")).find(el=>el.textContent.trim()==="Bots").click()',
  );
  await wait('!document.querySelector(".settings-page")', 'closed settings');
  await wait(
    'document.querySelector(".context-meter").textContent.includes("0%")',
    'configured capacity',
  );
  const conversation = api.store.get(
    "SELECT id FROM conversations WHERE owner_bot_id='scout' AND kind='private' ORDER BY created_at LIMIT 1",
  )!;
  const replyId = randomUUID();
  api.store.run(
    'INSERT INTO messages(id,bot_id,conversation_id,request_id,role,content,status,created_at,context_usage_json) VALUES(?,?,?,?,?,?,?,?,?)',
    replyId,
    'scout',
    String(conversation.id),
    randomUUID(),
    'assistant',
    'Context display fixture.',
    'complete',
    new Date().toISOString(),
    JSON.stringify({
      usedTokens: 16384,
      contextWindow: 65536,
      inputTokens: 16000,
      outputTokens: 384,
      estimated: false,
      runTokens: 40000,
      compactions: 1,
      phase: 'ready',
    }),
  );
  await evaluate('window.dispatchEvent(new Event("focus"))');
  await wait(
    'document.querySelector(".context-meter").textContent.includes("25%")',
    'reported usage',
  );
  assert.match(await evaluate<string>('document.querySelector(".context-meter").title'), /16,000/);
  const fits = await evaluate<boolean>(`(() => {
    const meter=document.querySelector('.context-meter').getBoundingClientRect();
    const send=document.querySelector('.send-button').getBoundingClientRect();
    const composer=document.querySelector('.composer').getBoundingClientRect();
    return meter.right < send.left && meter.left >= composer.left && meter.bottom <= composer.bottom;
  })()`);
  assert.equal(fits, true);
  const boundary: Extract<ResponsePart, { type: 'compaction' }> = {
    id: 'compaction-fixture',
    type: 'compaction',
    state: 'compacting',
    startedAt: new Date().toISOString(),
    tokensBefore: 24000,
  };
  const parts: ResponsePart[] = [
    { id: 'before', type: 'text', text: 'Checking the project.' },
    boundary,
  ];
  api.store.run('UPDATE messages SET parts_json=? WHERE id=?', JSON.stringify(parts), replyId);
  await evaluate('window.dispatchEvent(new Event("focus"))');
  await wait('Boolean(document.querySelector(".response-work"))', 'saved compaction activity');
  assert.equal(await evaluate<boolean>('document.querySelector(".response-work").open'), false);
  await evaluate('document.querySelector(".response-work > summary").click()');
  await wait('document.querySelector(".response-work").open', 'expanded compaction activity');
  assert.match(
    await evaluate<string>('document.querySelector(".response-compaction").textContent'),
    /Context compaction interrupted/,
  );
  boundary.state = 'complete';
  boundary.tokensAfter = 5000;
  boundary.finishedAt = new Date().toISOString();
  parts.push({ id: 'after', type: 'text', text: 'Resuming the project.' });
  api.store.run('UPDATE messages SET parts_json=? WHERE id=?', JSON.stringify(parts), replyId);
  await evaluate('window.dispatchEvent(new Event("focus"))');
  await wait(
    'document.querySelector(".response-compaction")?.textContent.includes("Context compacted")',
    'completed compaction divider',
  );
  assert.equal(
    await evaluate<boolean>(`(() => {
    const divider=document.querySelector('.response-compaction');
    const before=document.querySelector('.response-transcript .ai-markdown');
    const after=document.querySelector('.response-work').nextElementSibling;
    return before.textContent.includes('Checking the project') && after.textContent.includes('Resuming the project') && Boolean(before.compareDocumentPosition(divider)&Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(divider.compareDocumentPosition(after)&Node.DOCUMENT_POSITION_FOLLOWING);
  })()`),
    true,
  );
  api.store.run(
    "UPDATE messages SET status='complete',finished_at=? WHERE id=?",
    new Date().toISOString(),
    replyId,
  );
  await evaluate('window.dispatchEvent(new Event("focus"))');
  await wait(
    'Boolean(document.querySelector(".response-work"))',
    'collapsed work after compaction',
  );
  const loaded = new Promise<void>((resolve) =>
    window.webContents.once('did-finish-load', () => resolve()),
  );
  window.reload();
  await loaded;
  await wait(
    'Boolean(document.querySelector(".response-work"))',
    'saved compaction timeline after reload',
  );
  assert.equal(await evaluate<boolean>('document.querySelector(".response-work").open'), false);
  await evaluate('document.querySelector(".response-work > summary").click()');
  await wait('document.querySelector(".response-work").open', 'expanded saved timeline');
  assert.match(
    await evaluate<string>('document.querySelector(".response-compaction").textContent'),
    /Context compacted/,
  );
  console.log(
    'PASS compaction timeline: interrupted and completed dividers, chronology, collapsed work, persisted after reload',
  );
  await evaluate('document.querySelector(".context-meter").click()');
  await wait('Boolean(document.querySelector(".bot-editor"))', 'bot settings');
  await fill('.bot-editor label', 'Model', 'different-test-model');
  assert.equal(
    await evaluate<boolean>('document.querySelector(".bot-editor form").checkValidity()'),
    false,
  );
  await fill('.bot-editor label', 'Context window (tokens)', '32768');
  assert.equal(
    await evaluate<boolean>('document.querySelector(".bot-editor form").checkValidity()'),
    true,
  );
  await fill('.bot-editor label', 'Model', '');
  assert.equal(
    await evaluate<boolean>('Boolean(document.querySelector(".bot-run-settings"))'),
    false,
  );
  await evaluate('document.querySelector(".bot-editor form").requestSubmit()');
  await wait('!document.querySelector(".bot-editor")', 'saved bot model settings');
  assert.equal(api.store.get("SELECT model FROM bots WHERE id='scout'")?.model, null);
  console.log(
    'PASS context UI: required capacity, inherited limits, exact usage, composer layout, custom-model validation, persisted model settings',
  );
}
