import type RFB from '@novnc/novnc';

const LIMIT = 1024 * 1024;
function checkText(text: string) {
  if (new TextEncoder().encode(text).byteLength > LIMIT)
    throw new Error('Clipboard text must be at most 1 MB.');
}

type Viewer = Pick<RFB, 'clipboardPasteFrom' | 'sendKey' | 'focus'> & {
  addEventListener(type: string, listener: (event: CustomEvent) => void): void;
  removeEventListener(type: string, listener: (event: CustomEvent) => void): void;
};
interface ClipboardOptions {
  read(): Promise<string>;
  write(text: string): Promise<void>;
  remote(text: string | null): void;
  message(text: string): void;
  mac: boolean;
}

/** One connection owns its clipboard cache and pending paste, with no background reads. */
export function bindComputerClipboard(
  container: HTMLElement,
  viewer: Viewer,
  options: ClipboardOptions,
) {
  const document = container.ownerDocument;
  const window = document.defaultView!;
  let enabled = true;
  let connected = false;
  let disposed = false;
  let generation = 0;
  let pasting = false;
  let remote: string | null = null;
  const modifiers = new Map<string, number>();
  const modifierKeys: Record<string, number> = {
    ControlLeft: 0xffe3,
    ControlRight: 0xffe4,
    ShiftLeft: 0xffe1,
    ShiftRight: 0xffe2,
    // Match noVNC's macOS modifier translation when releasing/restoring keys.
    AltLeft: options.mac ? 0xff7e : 0xffe9,
    AltRight: options.mac ? 0xfe03 : 0xffea,
    MetaLeft: options.mac ? 0xffe9 : 0xffeb,
    MetaRight: options.mac ? 0xffeb : 0xffec,
  };
  const available = () => !disposed && connected && enabled;
  const focused = () =>
    available() &&
    document.visibilityState === 'visible' &&
    document.hasFocus() &&
    container.contains(document.activeElement);
  const cancel = () => {
    generation++;
    pasting = false;
  };
  const report = (failure: unknown) =>
    options.message(
      `${failure instanceof Error ? failure.message : 'Clipboard access failed.'} Open Clipboard to transfer text manually.`,
    );
  const reset = () => {
    cancel();
    modifiers.clear();
    remote = null;
    options.remote(null);
  };
  const send = (text: string) => {
    if (!available()) throw new Error('Connect to the VM and enable Control to send text.');
    checkText(text);
    viewer.clipboardPasteFrom(text);
  };
  const shortcut = (key: string, shift: boolean) => {
    // The user may release Ctrl during the async clipboard read, or still be holding
    // right Ctrl/Shift/Command. Send a complete chord, then restore physical modifiers
    // so the next shortcut works even when the user keeps Ctrl held down.
    for (const [code, keysym] of modifiers) viewer.sendKey(keysym, code, false);
    viewer.sendKey(0xffe3, 'ControlLeft', true);
    if (shift) viewer.sendKey(0xffe1, 'ShiftLeft', true);
    // X11 VNC servers may adjust Shift to match the supplied keysym. Sending
    // lowercase v with Shift held can therefore become Ctrl+V in a terminal.
    viewer.sendKey((shift ? key.toUpperCase() : key).charCodeAt(0), `Key${key.toUpperCase()}`);
    if (shift) viewer.sendKey(0xffe1, 'ShiftLeft', false);
    viewer.sendKey(0xffe3, 'ControlLeft', false);
    for (const [code, keysym] of modifiers) viewer.sendKey(keysym, code, true);
  };
  const paste = async (read: () => Promise<string>, shift: boolean) => {
    if (!focused() || pasting) return;
    const current = ++generation;
    pasting = true;
    try {
      const text = await read();
      if (current !== generation || !focused()) return;
      send(text);
      // Clipboard notification and paste travel on the same ordered VNC connection.
      // With extended clipboard, TigerVNC requests the text when the app pastes it.
      shortcut('v', shift);
      options.message('');
    } catch (failure) {
      if (current === generation && available()) report(failure);
    } finally {
      if (current === generation) pasting = false;
    }
  };
  const keydown = (event: KeyboardEvent) => {
    if (modifierKeys[event.code]) modifiers.set(event.code, modifierKeys[event.code]);
    if (pasting && !['v', 'control', 'shift', 'meta'].includes(event.key.toLowerCase())) cancel();
    if (!focused() || event.altKey || !(event.ctrlKey || (options.mac && event.metaKey))) return;
    const key = event.key.toLowerCase();
    if (key !== 'v' && !(options.mac && event.metaKey && ['c', 'x'].includes(key))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    if (key === 'v') void paste(options.read, event.shiftKey);
    else {
      cancel();
      shortcut(key, event.shiftKey);
    }
  };
  const pasteEvent = (event: ClipboardEvent) => {
    if (!focused()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const text = event.clipboardData?.getData('text/plain');
    if (text !== undefined) void paste(() => Promise.resolve(text), false);
  };
  const clipboard = (event: Event) => {
    if (!available()) return;
    const text: unknown = (event as CustomEvent<{ text?: unknown }>).detail?.text;
    if (typeof text !== 'string') return;
    try {
      checkText(text);
    } catch (failure) {
      remote = null;
      options.remote(null);
      report(failure);
      return;
    }
    remote = text;
    options.remote(text);
    // Host writes never trigger a send. Even a repeated remote value must be
    // copied: the user may have changed the host clipboard since pasting it.
    if (!focused() || pasting) return;
    const current = generation;
    void options.write(text).catch((failure) => {
      if (current === generation && available()) report(failure);
    });
  };
  const connect = () => {
    connected = true;
    reset();
  };
  const disconnect = () => {
    connected = false;
    reset();
  };
  const focusin = (event: FocusEvent) => {
    if (!container.contains(event.target as Node)) cancel();
  };
  const releaseModifiers = () => {
    cancel();
    if (available()) for (const [code, keysym] of modifiers) viewer.sendKey(keysym, code, false);
    modifiers.clear();
  };
  const keyup = (event: KeyboardEvent) => {
    modifiers.delete(event.code);
  };
  container.addEventListener('keydown', keydown, true);
  container.addEventListener('keyup', keyup, true);
  container.addEventListener('focusout', releaseModifiers);
  container.addEventListener('paste', pasteEvent, true);
  container.addEventListener('pointerdown', cancel, true);
  document.addEventListener('focusin', focusin);
  document.addEventListener('visibilitychange', cancel);
  window.addEventListener('blur', releaseModifiers);
  viewer.addEventListener('connect', connect);
  viewer.addEventListener('disconnect', disconnect);
  viewer.addEventListener('clipboard', clipboard);
  return {
    send,
    pasteText(text: string, terminal: boolean) {
      cancel();
      send(text);
      viewer.focus();
      shortcut('v', terminal);
      options.message('');
    },
    async copyRemote() {
      if (!available() || remote === null) throw new Error('Copy some text inside the VM first.');
      await options.write(remote);
    },
    setEnabled(value: boolean) {
      if (enabled === value) return;
      if (!value) releaseModifiers();
      enabled = value;
      reset();
    },
    dispose() {
      disposed = true;
      reset();
      container.removeEventListener('keydown', keydown, true);
      container.removeEventListener('keyup', keyup, true);
      container.removeEventListener('focusout', releaseModifiers);
      container.removeEventListener('paste', pasteEvent, true);
      container.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('focusin', focusin);
      document.removeEventListener('visibilitychange', cancel);
      window.removeEventListener('blur', releaseModifiers);
      viewer.removeEventListener('connect', connect);
      viewer.removeEventListener('disconnect', disconnect);
      viewer.removeEventListener('clipboard', clipboard);
    },
  };
}
