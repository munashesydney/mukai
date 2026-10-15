/** Desktop copying uses a narrow native IPC action; browsers retain their standard clipboard API. */
export async function copyText(text: string): Promise<void> {
  if (window.mukai) {
    await window.mukai.writeClipboardText(text);
  } else {
    if (!navigator.clipboard) throw new Error('Clipboard access requires HTTPS or localhost.');
    await navigator.clipboard.writeText(text);
  }
}
