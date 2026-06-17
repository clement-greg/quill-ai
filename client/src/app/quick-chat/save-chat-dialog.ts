import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ChatFolder } from '@shared/models';
import { Series } from '@shared/models/series.model';
import { QuickChatService } from '../services/quick-chat.service';

interface Crumb {
  id: string | null;
  name: string;
}

/**
 * Asks the user where in the Resource Manager to save the current quick-chat
 * conversation, using a Windows-style folder browser: pick a series, then
 * single-click to select a destination folder or double-click to navigate into
 * it. The save target is the highlighted folder, or the current folder if none.
 */
@Component({
  selector: 'app-save-chat-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatDialogModule,
    MatFormFieldModule,
    MatSelectModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title>Save conversation</h2>
    <mat-dialog-content>
      @if (loadingSeries()) {
        <div class="loading-row"><mat-spinner diameter="20"></mat-spinner><span>Loading…</span></div>
      } @else if (series().length === 0) {
        <p class="empty">You don't have any series yet to save this into.</p>
      } @else {
        <mat-form-field appearance="outline" class="field">
          <mat-label>Series</mat-label>
          <mat-select [ngModel]="selectedSeriesId()" (ngModelChange)="onSeriesChange($event)">
            @for (s of series(); track s.id) {
              <mat-option [value]="s.id">{{ s.title || 'Untitled series' }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <!-- Breadcrumb path -->
        <nav class="crumbs" aria-label="Folder path">
          @for (c of breadcrumbs(); track c.id; let last = $last) {
            <button type="button" class="crumb" [class.current]="last"
                    [disabled]="last" (click)="navigateTo(c.id)">
              @if (c.id === null) { <mat-icon class="crumb-icon">home</mat-icon> }
              <span>{{ c.name }}</span>
            </button>
            @if (!last) { <mat-icon class="crumb-sep">chevron_right</mat-icon> }
          }
        </nav>

        <!-- Folder list (single-click to select, double-click to open) -->
        <div class="browser" role="listbox" aria-label="Folders">
          @if (loadingFolders()) {
            <div class="loading-row"><mat-spinner diameter="18"></mat-spinner><span>Loading…</span></div>
          } @else if (childFolders().length === 0) {
            <div class="browser-empty">This folder has no subfolders. Save it here, or pick another location.</div>
          } @else {
            @for (f of childFolders(); track f.id) {
              <button type="button" class="row" role="option"
                      [class.selected]="selectedChildId() === f.id"
                      [attr.aria-selected]="selectedChildId() === f.id"
                      (click)="selectedChildId.set(f.id)"
                      (dblclick)="open(f.id)">
                <mat-icon class="row-icon">folder</mat-icon>
                <span class="row-name">{{ f.name }}</span>
                @if (hasChildren(f.id)) { <mat-icon class="row-chevron">chevron_right</mat-icon> }
              </button>
            }
          }
        </div>

        <p class="dest">Saving to: <strong>{{ destinationLabel() }}</strong></p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close [disabled]="saving()">Cancel</button>
      <button mat-flat-button [disabled]="!selectedSeriesId() || saving()" (click)="save()">
        @if (saving()) { <mat-spinner diameter="18"></mat-spinner> } @else { Save here }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { width: min(460px, 92vw); box-sizing: border-box; }
    .field { width: 100%; }
    .loading-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
    .empty { color: var(--mat-sys-on-surface-variant); }

    .crumbs {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 2px;
      margin: 4px 0 6px;
    }
    .crumb {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: none;
      background: none;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 6px;
      color: var(--mat-sys-primary);
      font: inherit;
    }
    .crumb:hover:not(:disabled) { background: var(--mat-sys-surface-container-high); }
    .crumb.current { color: var(--mat-sys-on-surface); font-weight: 600; cursor: default; }
    .crumb-icon { font-size: 18px; width: 18px; height: 18px; }
    .crumb-sep { font-size: 18px; width: 18px; height: 18px; color: var(--mat-sys-on-surface-variant); }

    .browser {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 10px;
      min-height: 160px;
      max-height: 240px;
      overflow-y: auto;
      padding: 4px;
    }
    .browser-empty { padding: 16px; color: var(--mat-sys-on-surface-variant); font-size: 0.88rem; }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      border: none;
      background: none;
      text-align: left;
      cursor: pointer;
      padding: 8px 10px;
      border-radius: 8px;
      font: inherit;
      color: var(--mat-sys-on-surface);
      user-select: none;
    }
    .row:hover { background: var(--mat-sys-surface-container-high); }
    .row.selected { background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); }
    .row-icon { color: #f0b429; }
    .row.selected .row-icon { color: inherit; }
    .row-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-chevron { color: var(--mat-sys-on-surface-variant); font-size: 18px; width: 18px; height: 18px; }
    .row.selected .row-chevron { color: inherit; }

    .dest { margin: 10px 2px 0; font-size: 0.85rem; color: var(--mat-sys-on-surface-variant); }
    button mat-spinner { display: inline-block; }
  `],
})
export class SaveChatDialogComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<SaveChatDialogComponent>);
  private readonly quickChat = inject(QuickChatService);

  readonly series = signal<Series[]>([]);
  readonly loadingSeries = signal(true);
  readonly selectedSeriesId = signal<string | null>(null);

  private readonly folders = signal<ChatFolder[]>([]);
  readonly loadingFolders = signal(false);

  /** The folder currently being browsed (null = top level). */
  readonly currentFolderId = signal<string | null>(null);
  /** A folder highlighted by single click; becomes the save target if set. */
  readonly selectedChildId = signal<string | null>(null);

  readonly saving = signal(false);

  private readonly foldersById = computed(() => {
    const map = new Map<string, ChatFolder>();
    for (const f of this.folders()) map.set(f.id, f);
    return map;
  });

  /** Subfolders of the folder currently being browsed, alphabetical. */
  readonly childFolders = computed(() =>
    this.folders()
      .filter(f => (f.parentFolderId ?? null) === this.currentFolderId())
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  /** Path from the series root down to the current folder. */
  readonly breadcrumbs = computed<Crumb[]>(() => {
    const seriesTitle = this.series().find(s => s.id === this.selectedSeriesId())?.title;
    const crumbs: Crumb[] = [{ id: null, name: seriesTitle || 'Top level' }];
    const chain: Crumb[] = [];
    let id = this.currentFolderId();
    const byId = this.foldersById();
    while (id) {
      const folder = byId.get(id);
      if (!folder) break;
      chain.unshift({ id: folder.id, name: folder.name });
      id = folder.parentFolderId ?? null;
    }
    return [...crumbs, ...chain];
  });

  /** The actual save destination: the highlighted child, else the current folder. */
  private readonly destinationId = computed(() => this.selectedChildId() ?? this.currentFolderId());

  readonly destinationLabel = computed(() => {
    const destId = this.destinationId();
    if (destId === null) return this.breadcrumbs()[0].name;
    return this.foldersById().get(destId)?.name ?? 'Top level';
  });

  hasChildren(folderId: string): boolean {
    return this.folders().some(f => (f.parentFolderId ?? null) === folderId);
  }

  async ngOnInit(): Promise<void> {
    const list = await this.quickChat.listSeries();
    this.series.set(list);
    this.loadingSeries.set(false);
    if (list.length === 1) await this.onSeriesChange(list[0].id);
  }

  async onSeriesChange(seriesId: string): Promise<void> {
    this.selectedSeriesId.set(seriesId);
    this.currentFolderId.set(null);
    this.selectedChildId.set(null);
    this.folders.set([]);
    this.loadingFolders.set(true);
    this.folders.set(await this.quickChat.listFolders(seriesId));
    this.loadingFolders.set(false);
  }

  /** Double-click: navigate into a folder. */
  open(folderId: string): void {
    this.currentFolderId.set(folderId);
    this.selectedChildId.set(null);
  }

  /** Breadcrumb click: jump to an ancestor folder. */
  navigateTo(folderId: string | null): void {
    this.currentFolderId.set(folderId);
    this.selectedChildId.set(null);
  }

  async save(): Promise<void> {
    const seriesId = this.selectedSeriesId();
    if (!seriesId || this.saving()) return;
    this.saving.set(true);
    const ok = await this.quickChat.saveToResourceManager(seriesId, this.destinationId());
    this.saving.set(false);
    if (ok) this.dialogRef.close(true);
  }
}
