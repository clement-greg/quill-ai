/** localStorage key for whether the chapter editor's sidebar is collapsed. */
export const SIDEBAR_COLLAPSED_KEY = 'chapter-edit-sidebar-collapsed';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Whether the author last left the sidebar collapsed. Open unless they chose
 *  otherwise — including when storage is unavailable or unreadable. */
export function readSidebarCollapsed(store: Store | null | undefined): boolean {
  try {
    return store?.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remembers the author's choice; a storage failure just leaves it unsaved. */
export function writeSidebarCollapsed(store: Store | null | undefined, collapsed: boolean): void {
  try {
    store?.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch { /* storage full or blocked — keep the in-memory choice */ }
}
