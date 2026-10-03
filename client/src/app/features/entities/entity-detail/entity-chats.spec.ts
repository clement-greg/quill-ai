import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatSessionSummary } from '@shared/models';
import { QuickChatService } from '@app/features/ai/quick-chat.service';
import { EntityChatsComponent } from './entity-chats';

const chat = (id: string, name = `Chat ${id}`): ChatSessionSummary =>
  ({ id, name, pinned: false, entityId: 'ent-1', updatedAt: '2026-01-01T00:00:00.000Z' });

describe('EntityChatsComponent', () => {
  let quickChat: {
    attachedEntityId: ReturnType<typeof signal<string | null>>;
    activeSessionId: ReturnType<typeof signal<string | null>>;
    getEntityChats: ReturnType<typeof vi.fn>;
    startEntityChat: ReturnType<typeof vi.fn>;
    loadSession: ReturnType<typeof vi.fn>;
    setSessionEntity: ReturnType<typeof vi.fn>;
  };

  async function create(chats: ChatSessionSummary[] = [], entityId = 'ent-1') {
    quickChat = {
      attachedEntityId: signal<string | null>(null),
      activeSessionId: signal<string | null>(null),
      getEntityChats: vi.fn(async () => chats),
      startEntityChat: vi.fn(async () => undefined),
      loadSession: vi.fn(async () => undefined),
      setSessionEntity: vi.fn(async () => true),
    };
    TestBed.configureTestingModule({
      imports: [EntityChatsComponent],
      providers: [{ provide: QuickChatService, useValue: quickChat }],
    });
    const fixture = TestBed.createComponent(EntityChatsComponent);
    fixture.componentRef.setInput('entityId', entityId);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  it('lists the chats attached to the entity with a count', async () => {
    const fixture = await create([chat('a', 'Backstory ideas'), chat('b', 'Her rivals')]);
    const el = fixture.nativeElement as HTMLElement;

    expect(quickChat.getEntityChats).toHaveBeenCalledWith('ent-1');
    expect([...el.querySelectorAll('.chat-name')].map(n => n.textContent)).toEqual(['Backstory ideas', 'Her rivals']);
    expect(el.querySelector('.section-count')?.textContent).toBe('2');
  });

  it('shows an empty hint when nothing is attached', async () => {
    const el = (await create([])).nativeElement as HTMLElement;
    expect(text(el.querySelector('.empty-hint')!)).toContain('No chats yet');
    expect(el.querySelector('.section-count')).toBeNull();
  });

  it('starts a new chat attached to this entity', async () => {
    const fixture = await create([]);
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.section-action')!.click();
    expect(quickChat.startEntityChat).toHaveBeenCalledWith('ent-1');
  });

  it('opens a chat in Ask Quill', async () => {
    const fixture = await create([chat('a')]);
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.chat-item')!.click();
    expect(quickChat.loadSession).toHaveBeenCalledWith('a', true);
  });

  it('detaches a chat and drops it from the list', async () => {
    const fixture = await create([chat('a'), chat('b')]);
    await fixture.componentInstance.detachChat(chat('a'));
    fixture.detectChanges();

    expect(quickChat.setSessionEntity).toHaveBeenCalledWith('a', null);
    expect(fixture.componentInstance.chats().map(c => c.id)).toEqual(['b']);
  });

  it('keeps a chat listed when detaching fails', async () => {
    const fixture = await create([chat('a')]);
    quickChat.setSessionEntity.mockResolvedValue(false);
    await fixture.componentInstance.detachChat(chat('a'));
    expect(fixture.componentInstance.chats().map(c => c.id)).toEqual(['a']);
  });

  it('reloads when Ask Quill attaches a different chat', async () => {
    const fixture = await create([]);
    quickChat.getEntityChats.mockResolvedValue([chat('new')]);

    quickChat.activeSessionId.set('new');
    quickChat.attachedEntityId.set('ent-1');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(quickChat.getEntityChats).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.chats().map(c => c.id)).toEqual(['new']);
  });

  it('ignores a late response for an entity it has navigated away from', async () => {
    const fixture = await create([chat('a')], 'ent-1');
    let resolveOld!: (v: ChatSessionSummary[]) => void;
    quickChat.getEntityChats.mockImplementationOnce(() => new Promise(r => { resolveOld = r; }));
    quickChat.activeSessionId.set('x');
    fixture.detectChanges();

    quickChat.getEntityChats.mockResolvedValue([chat('other')]);
    fixture.componentRef.setInput('entityId', 'ent-2');
    fixture.detectChanges();
    await fixture.whenStable();

    resolveOld([chat('stale')]);
    await fixture.whenStable();
    expect(fixture.componentInstance.chats().map(c => c.id)).toEqual(['other']);
  });
});
