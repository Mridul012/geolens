/** A full-page navigation to another origin (e.g. an OAuth provider), which the router can't do. */
export function navigateAway(url: string): void {
  window.location.assign(url);
}
