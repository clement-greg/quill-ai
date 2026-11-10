import { readSidebarCollapsed, SIDEBAR_COLLAPSED_KEY, writeSidebarCollapsed } from './sidebar-collapse';

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    data,
  };
}

const throwing = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('quota'); },
};

describe('readSidebarCollapsed', () => {
  it('is open by default when nothing is stored', () => {
    expect(readSidebarCollapsed(memoryStore())).toBe(false);
  });

  it('is collapsed when the author left it collapsed', () => {
    expect(readSidebarCollapsed(memoryStore({ [SIDEBAR_COLLAPSED_KEY]: '1' }))).toBe(true);
  });

  it('is open when the author left it open', () => {
    expect(readSidebarCollapsed(memoryStore({ [SIDEBAR_COLLAPSED_KEY]: '0' }))).toBe(false);
  });

  it('treats unexpected stored values as open', () => {
    expect(readSidebarCollapsed(memoryStore({ [SIDEBAR_COLLAPSED_KEY]: 'true' }))).toBe(false);
  });

  it('stays open when storage is missing or throws', () => {
    expect(readSidebarCollapsed(null)).toBe(false);
    expect(readSidebarCollapsed(throwing)).toBe(false);
  });
});

describe('writeSidebarCollapsed', () => {
  it('round-trips the choice', () => {
    const store = memoryStore();
    writeSidebarCollapsed(store, true);
    expect(store.data.get(SIDEBAR_COLLAPSED_KEY)).toBe('1');
    expect(readSidebarCollapsed(store)).toBe(true);
    writeSidebarCollapsed(store, false);
    expect(readSidebarCollapsed(store)).toBe(false);
  });

  it('does not throw when storage is missing or fails', () => {
    expect(() => writeSidebarCollapsed(null, true)).not.toThrow();
    expect(() => writeSidebarCollapsed(throwing, true)).not.toThrow();
  });
});
