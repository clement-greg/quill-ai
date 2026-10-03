import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatSessionSummary } from '@shared/models';
import { QuickChatService } from '@app/features/ai/quick-chat.service';

/**
 * The "Chats" section of an entity's overview: Ask Quill conversations attached
 * to the entity, with a button to start a new one. Attached chats are grounded
 * in the entity's story-bible record, and are moved here out of the Resource
 * Manager's folders until detached.
 */
@Component({
  selector: 'app-entity-chats',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatTooltipModule],
  template: `
    <section class="detail-section" aria-labelledby="entity-chats-title">
      <h2 class="section-title" id="entity-chats-title">
        Chats
        @if (chats().length > 0) {
          <span class="section-count">{{ chats().length }}</span>
        }
        <button mat-stroked-button class="section-action" (click)="startChat()"
                aria-label="Start a new chat about this entity">
          <mat-icon>add_comment</mat-icon>
          New chat
        </button>
      </h2>

      @if (loading()) {
        <div class="section-loading"><mat-spinner diameter="32" /></div>
      } @else if (chats().length === 0) {
        <p class="empty-hint">No chats yet. Start one, or attach an existing chat from the Resource Manager.</p>
      } @else {
        <ul class="chat-list">
          @for (chat of chats(); track chat.id) {
            <li class="chat-row" [class.chat-row--active]="quickChat.activeSessionId() === chat.id">
              <button class="chat-item" (click)="openChat(chat.id)">
                <mat-icon class="chat-icon">chat</mat-icon>
                <span class="chat-name">{{ chat.name }}</span>
                <mat-icon class="chat-open">chevron_right</mat-icon>
              </button>
              <button mat-icon-button class="chat-detach" (click)="detachChat(chat)"
                      matTooltip="Detach from entity" [attr.aria-label]="'Detach ' + chat.name + ' from this entity'">
                <mat-icon>link_off</mat-icon>
              </button>
            </li>
          }
        </ul>
      }
    </section>
  `,
  // The section chrome matches entity-detail's sections, whose styles are
  // encapsulated to that component and so don't reach in here.
  styles: [`
    .detail-section { margin-bottom: 40px; }
    .section-title {
      font-size: 1.1rem;
      font-weight: 600;
      margin: 0 0 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--mat-sys-outline-variant, #cac4d0);
      padding-bottom: 8px;
    }
    .section-count {
      font-size: 0.85rem;
      font-weight: 400;
      color: var(--mat-sys-on-surface-variant, #49454f);
      background: var(--mat-sys-surface-variant, #e8e0f0);
      border-radius: 10px;
      padding: 1px 8px;
    }
    .section-action { margin-left: auto; }
    .section-loading { display: flex; justify-content: center; padding: 24px 0; }
    .empty-hint { color: var(--mat-sys-on-surface-variant, #49454f); font-style: italic; margin: 0; }
    .chat-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    .chat-row { display: flex; align-items: center; border-radius: 8px; }
    .chat-row--active { background: var(--mat-sys-secondary-container, #e8def8); }
    .chat-item {
      all: unset;
      cursor: pointer;
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 8px;
      transition: background 0.15s ease;
    }
    .chat-item:hover { background: var(--mat-sys-surface-variant, #e8e0f0); }
    .chat-item:focus-visible { outline: 2px solid var(--mat-sys-primary, #6750a4); outline-offset: -2px; }
    .chat-icon { color: var(--mat-sys-primary, #6750a4); flex-shrink: 0; }
    .chat-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chat-open { color: var(--mat-sys-on-surface-variant, #49454f); flex-shrink: 0; }
    .chat-detach { flex-shrink: 0; color: var(--mat-sys-on-surface-variant, #49454f); }
  `],
})
export class EntityChatsComponent {
  readonly entityId = input.required<string>();

  readonly quickChat = inject(QuickChatService);

  readonly chats = signal<ChatSessionSummary[]>([]);
  readonly loading = signal(true);

  constructor() {
    effect(() => {
      const id = this.entityId();
      // Reload when Ask Quill attaches/detaches or switches chats, so a chat
      // started or detached elsewhere shows up here without a refresh.
      this.quickChat.attachedEntityId();
      this.quickChat.activeSessionId();
      untracked(() => void this.load(id, this.chats().length === 0));
    });
  }

  private async load(entityId: string, showSpinner: boolean): Promise<void> {
    if (showSpinner) this.loading.set(true);
    const chats = await this.quickChat.getEntityChats(entityId);
    // Ignore a response for an entity we've since navigated away from.
    if (entityId !== this.entityId()) return;
    this.chats.set(chats);
    this.loading.set(false);
  }

  startChat(): void {
    void this.quickChat.startEntityChat(this.entityId());
  }

  openChat(sessionId: string): void {
    void this.quickChat.loadSession(sessionId, true);
  }

  async detachChat(chat: ChatSessionSummary): Promise<void> {
    const ok = await this.quickChat.setSessionEntity(chat.id, null);
    if (ok) this.chats.update(list => list.filter(c => c.id !== chat.id));
  }
}
