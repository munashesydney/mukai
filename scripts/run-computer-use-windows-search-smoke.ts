import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ComputerUseService } from '../src/server/services/computerUseService';
import { NativeDesktopBackend } from '../src/server/computer/computer_use/nativeBackend';
import type { ComputerUseInput } from '../src/server/tools/computer_use/definition';

const executeFile = promisify(execFile);
const focusSchema = z.object({
  process: z.string(),
  editable: z.boolean(),
  value: z.string().nullable(),
});
// Read-only oracle: input must still come from the real computer_use tool.
const inspectFocus = String.raw`
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$element = [System.Windows.Automation.AutomationElement]::FocusedElement
$value = $null
$editable = $false
if ($element) {
  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $editable = -not $pattern.Current.IsReadOnly
    $value = $pattern.Current.Value
  } catch {}
}
$processName = if ($element) { (Get-Process -Id $element.Current.ProcessId).ProcessName } else { '' }
@{process=$processName; editable=$editable; value=$value} | ConvertTo-Json -Compress
`;

async function main() {
  if (process.platform !== 'win32') throw new Error('This smoke test requires Windows.');
  const service = new ComputerUseService(new NativeDesktopBackend());
  const owner = { workspaceId: 'computer-use-smoke', botId: 'smoke', conversationId: 'search' };
  const signal = AbortSignal.timeout(60000);
  const run = (input: ComputerUseInput) => service.execute(owner, input, signal);
  const focus = async () => {
    const { stdout } = await executeFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', inspectFocus],
      { windowsHide: true, signal, timeout: 10000 },
    );
    return focusSchema.parse(JSON.parse(stdout));
  };
  const searchBox = (value: z.infer<typeof focusSchema>) =>
    ['SearchHost', 'SearchApp', 'SearchUI'].includes(value.process) && value.editable;
  try {
    await run({ action: 'press', key: 'WIN+S' });
    let ready = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      await delay(250, undefined, { signal });
      if (searchBox(await focus())) {
        ready = true;
        break;
      }
    }
    assert.ok(ready, 'Windows search did not focus an editable search box.');
    await run({ action: 'press', key: 'CTRL+A' });
    // Exercise the normal typing action. Never press Enter or launch a search result.
    const text = 'notepad';
    await run({ action: 'type', text });
    let observed: z.infer<typeof focusSchema> | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      await delay(100, undefined, { signal });
      observed = await focus();
      assert.ok(searchBox(observed), 'Focus left the Windows search box during typing.');
      if (observed.value === text) break;
    }
    assert.equal(observed?.value, text, 'Unicode typing did not arrive in Windows search.');
    console.log('WIN+S and Unicode typing in the focused Windows search box passed.');
  } finally {
    try {
      // Do not send Escape to another application if the human changed focus.
      if (searchBox(await focus()))
        await service.execute(owner, { action: 'press', key: 'ESCAPE' }, AbortSignal.timeout(5000));
    } finally {
      await service.shutdown();
    }
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
