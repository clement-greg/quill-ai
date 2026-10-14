/** Elements that are unwrapped (children kept) from editor HTML: transient
 *  highlights and browser-injected formatting that must never be saved. */
const UNWRAP_SELECTOR = 'mark.grammar-error, mark[data-search-match], font';
/** Elements removed outright. */
const REMOVE_SELECTOR = '.ai-insertion-marker';

/**
 * Strips transient editor state from HTML before it is stored or displayed:
 * grammar-check marks, find-in-page highlights, AI insertion markers and the
 * `<font color>` wrappers Chrome adds when breaking out of a styled span.
 * Returns the input unchanged (same string) when there is nothing to strip.
 */
export function cleanEditorHtml(value: string): string {
  const mayNeedClean = value.includes('grammar-error') || value.includes('data-search-match')
    || value.includes('ai-insertion-marker') || value.includes('<font');
  if (!mayNeedClean) return value;
  const div = document.createElement('div');
  div.innerHTML = value;
  div.querySelectorAll(REMOVE_SELECTOR).forEach(el => el.remove());
  div.querySelectorAll(UNWRAP_SELECTOR).forEach(el => {
    const parent = el.parentNode!;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  });
  div.normalize();
  return div.innerHTML;
}
