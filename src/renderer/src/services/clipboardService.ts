/** Desktop copying uses a narrow native IPC action; browsers retain their standard clipboard API. */
export async function copyText(text: string): Promise<void> {
  if (window.mukai) {
    await window.mukai.writeClipboardText(text);
  } else {
    if (!navigator.clipboard) throw new Error('Clipboard access requires HTTPS or localhost.');
    await navigator.clipboard.writeText(text);
  }
}

/** Read only in response to a paste action; never poll the host clipboard. */
export async function readClipboardText(): Promise<string> {
  if (window.mukai) return window.mukai.readClipboardText();
  if (!navigator.clipboard?.readText)
    throw new Error(
      'Clipboard access requires HTTPS or localhost. Use the Clipboard panel to paste text.',
    );
  return navigator.clipboard.readText();
}
