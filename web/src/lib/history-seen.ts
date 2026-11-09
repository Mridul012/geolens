/**
 * When this device last opened a project's History page. A per-device convenience for the
 * sidebar's "new results" dot only — events themselves live on the server, so a cleared or
 * blocked localStorage just means the dot shows once more, never that anything is lost.
 */
const keyFor = (projectId: string) => `geolens:history-seen:${projectId}`;

/** Fired in this tab when History is visited; `storage` covers other tabs. */
const SEEN_EVENT = "geolens:history-seen";

export function subscribeHistorySeen(onChange: () => void): () => void {
  window.addEventListener(SEEN_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(SEEN_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function readHistorySeen(projectId: string): number | null {
  try {
    const raw = window.localStorage.getItem(keyFor(projectId));
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function markHistorySeen(projectId: string, at: number = Date.now()): void {
  try {
    window.localStorage.setItem(keyFor(projectId), String(at));
  } catch {
    // Storage unavailable (private mode, blocked site data): the dot simply stays visible.
  }
  window.dispatchEvent(new Event(SEEN_EVENT));
}
