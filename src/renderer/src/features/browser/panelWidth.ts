export const BROWSER_WIDTH_KEY = 'mukai.browser-panel.width';
export function browserPanelWidth(preferred: number, windowWidth: number) {
  const maximum = Math.max(280, windowWidth - 600);
  const minimum = Math.min(320, maximum);
  return Math.round(
    Math.min(maximum, Math.max(minimum, Number.isFinite(preferred) ? preferred : 640)),
  );
}
export function loadBrowserPanelWidth() {
  try {
    const saved = localStorage.getItem(BROWSER_WIDTH_KEY);
    return saved === null ? 640 : Number(saved);
  } catch {
    return 640;
  }
}
