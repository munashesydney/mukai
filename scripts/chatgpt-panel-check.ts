import assert from 'node:assert/strict';
import type { BrowserWindow } from 'electron';

/** Production React forms with test-only API responses; no OAuth or billable calls. */
export async function checkChatGPTPanel(window: BrowserWindow) {
  const evaluate = async <T>(code: string): Promise<T> => {
    const result = await window.webContents.executeJavaScript(
      `(() => { try { return (${code}); } catch (error) { return {__smokeError:error.message}; } })()`,
    );
    if (result && typeof result === 'object' && '__smokeError' in result)
      throw new Error(`ChatGPT panel: ${result.__smokeError}; script: ${code}`);
    return result;
  };
  const wait = async (code: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate<boolean>(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('ChatGPT panel did not settle: ' + code);
  };
  await evaluate(`(() => {
    const original=window.fetch;
    window.__restoreChatGPTFetch=()=>{window.fetch=original;};
    window.__chatgptModelLoads=0;
    const id='00000000-0000-4000-8000-000000000001';
    const provider={id,name:'ChatGPT fixture',kind:'chatgpt',baseUrl:'',defaultModel:'gpt-6.1-sol',supportsImages:true,isDefault:false,hasKey:false,contextWindowTokens:200000,maxOutputTokens:8192,account:{label:'test account · fixture',clientId:'oaiapp_fixture',connected:true,planEnabled:true}};
    const models=[{id:'gpt-6.1-sol',name:'GPT Sol',category:'GPT',contextWindowTokens:200000,supportsImages:true},{id:'gpt-5-codex',name:'Codex',category:'Codex',contextWindowTokens:128000,supportsImages:false},{id:'o3',name:'o3',category:'Reasoning',contextWindowTokens:null,supportsImages:null},{id:'future',name:'Future',category:'Other',contextWindowTokens:null,supportsImages:null}];
    const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
    window.fetch=async(input,init)=>{
      const path=new URL(String(input),location.href).pathname;
      if(path.endsWith('/providers/'+id+'/models')){window.__chatgptModelLoads++;return json(models);}
      if(path.endsWith('/providers/chatgpt-auth')&&init?.method==='POST')return json({id:'test-attempt',status:'pending'});
      if(path.endsWith('/providers/chatgpt-auth/test-attempt'))return json({id:'test-attempt',status:'complete',providerId:id,message:'ChatGPT connected. Choose a model to finish setup.'});
      if(path.endsWith('/providers')&&(!init?.method||init.method==='GET')){const response=await original(input,init);return json([...(await response.json()),provider]);}
      return original(input,init);
    };
  })()`);
  try {
    await evaluate('document.querySelector(".rail-settings").click()');
    await wait('Boolean(document.querySelector("#settings-tab-providers"))');
    await evaluate('document.querySelector("#settings-tab-providers").click()');
    await wait(
      'Array.from(document.querySelectorAll(".provider-card")).some(el=>el.textContent.includes("ChatGPT fixture"))',
    );
    await evaluate(
      'Array.from(document.querySelectorAll(".provider-card")).find(el=>el.textContent.includes("ChatGPT fixture")).querySelector("button").click()',
    );
    await wait(`document.querySelector('select[aria-label="ChatGPT model"]')?.options.length===5`);
    assert.deepEqual(
      await evaluate<string[]>(
        'Array.from(document.querySelectorAll(".provider-panel optgroup")).map(el=>el.label)',
      ),
      ['GPT', 'Codex', 'Reasoning', 'Other'],
    );
    assert.equal(
      await evaluate<boolean>(
        'Array.from(document.querySelectorAll(".provider-panel label")).some(el=>el.textContent.includes("API key"))',
      ),
      false,
    );
    await evaluate(
      `(() => {const select=document.querySelector('select[aria-label="ChatGPT model"]');select.value='gpt-5-codex';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await wait(
      'Array.from(document.querySelectorAll(".provider-panel label")).find(el=>el.textContent.includes("Context window")).querySelector("input").value==="128000"',
    );
    assert.match(
      await evaluate<string>('document.querySelector(".provider-panel").textContent'),
      /Output reserve/,
    );
    await evaluate(
      'Array.from(document.querySelectorAll(".provider-panel button")).find(el=>el.textContent.trim()==="Refresh models").click()',
    );
    await wait('window.__chatgptModelLoads===2');
    await evaluate(
      'Array.from(document.querySelectorAll(".provider-panel button")).find(el=>el.textContent.trim()==="Reconnect ChatGPT").click()',
    );
    await wait('document.querySelector(".ai-notice")?.textContent.includes("ChatGPT connected")');
    assert.equal(
      await evaluate<boolean>(
        `Boolean(document.querySelector('select[aria-label="ChatGPT model"]'))`,
      ),
      true,
    );
    await evaluate(
      'Array.from(document.querySelectorAll(".rail-link")).find(el=>el.textContent.trim()==="Bots").click()',
    );
    await wait('!document.querySelector(".settings-page")');
    console.log(
      'PASS ChatGPT UI: account label, grouped catalog, capability metadata, output reserve, refresh, reconnect polling',
    );
  } finally {
    await evaluate(
      '(() => {window.__restoreChatGPTFetch(); delete window.__restoreChatGPTFetch; delete window.__chatgptModelLoads;})()',
    );
  }
}
