import { spawn } from 'node:child_process';

/** Fixed setup commands only. Arguments never come from a model or HTTP caller. */
export function setupProcess(
  binary: string,
  args: string[],
  signal: AbortSignal,
  input?: string,
  onOutput?: (text: string) => void,
  timeoutMs = 30 * 60 * 1000,
): Promise<{ code: number; output: string }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|LANG|LC_ALL|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|HOMEDRIVE|HOMEPATH|HOME)$/i.test(
          key,
        ),
      ),
    );
    const child = spawn(binary, args, { windowsHide: true, env });
    let output = '';
    const append = (bytes: Buffer) => {
      const text = bytes.toString();
      output = (output + text).slice(-12000);
      onOutput?.(text);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.stdin.on('error', () => {});
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(new Error('VM setup interrupted. You can resume it next time.'));
      else if (timedOut) reject(new Error('VM setup timed out. Retry setup to continue.'));
      else resolve({ code: code ?? -1, output });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
