import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ChatFolder } from '@shared/models';
import { Series } from '@shared/models/series.model';
import { AuthFetchService } from '@app/core/services/auth-fetch.service';

interface Crumb {
  id: string | null;
  name: string;
}

export interface FolderLocationPickerData {
  /** Preselects this series when provided. */
  seriesId?: string | null;
  title?: string;
  /** When true, a folder must be chosen (top level is not a valid target). */
  requireFolder?: boolean;
}

export interface FolderLocation {
  seriesId: string;
  folderId: string | null;
}

/**
 * A Windows-style folder browser for choosing a destination in the Resource
 * Manager (series → folder). Closes with the chosen {@link FolderLocation}, or
 * undefined on cancel. Unlike the save-chat dialog, it performs no save itself —
 * the caller decides what to write to the selected location.
 */
@Component({
  selector: 'app-folder-location-picker-dialog',
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
    <h2 mat-dialog-title>{{ data.title || 'Save to Resource Manager' }}</h2>
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
        @if (data.requireFolder && destinationId() === null) {
          <p class="dest dest-warn">Select a folder to save the image into.</p>
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="!canSave()" (click)="save()">Save here</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { width: min(460px, 92vw); box-sizing: border-box; }
    .field { width: 100%; }
    .loading-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
    .empty { color: var(--mat-sys-on-surface-variant); }

    .crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; margin: 4px 0 6px; }
    .crumb {
      display: inline-flex; align-items: center; gap: 4px;
      border: none; background: none; cursor: pointer;
      padding: 2px 6px; border-radius: 6px; color: var(--mat-sys-primary); font: inherit;
    }
    .crumb:hover:not(:disabled) { background: var(--mat-sys-surface-container-high); }
    .crumb.current { color: var(--mat-sys-on-surface); font-weight: 600; cursor: default; }
    .crumb-icon { font-size: 18px; width: 18px; height: 18px; }
    .crumb-sep { font-size: 18px; width: 18px; height: 18px; color: var(--mat-sys-on-surface-variant); }

    .browser {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 10px; min-height: 160px; max-height: 240px; overflow-y: auto; padding: 4px;
    }
    .browser-empty { padding: 16px; color: var(--mat-sys-on-surface-variant); font-size: 0.88rem; }
    .row {
      display: flex; align-items: center; gap: 10px; width: 100%;
      border: none; background: none; text-align: left; cursor: pointer;
      padding: 8px 10px; border-radius: 8px; font: inherit; color: var(--mat-sys-on-surface); user-select: none;
    }
    .row:hover { background: var(--mat-sys-surface-container-high); }
    .row.selected { background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); }
    .row-icon { color: #f0b429; }
    .row.selected .row-icon { color: inherit; }
    .row-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-chevron { color: var(--mat-sys-on-surface-variant); font-size: 18px; width: 18px; height: 18px; }
    .row.selected .row-chevron { color: inherit; }

    .dest { margin: 10px 2px 0; font-size: 0.85rem; color: var(--mat-sys-on-surface-variant); }
    .dest-warn { color: var(--mat-sys-error); margin-top: 4px; }
  `],
})
export class FolderLocationPickerDialogComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<FolderLocationPickerDialogComponent, FolderLocation>);
  readonly data = inject<FolderLocationPickerData>(MAT_DIALOG_DATA);
  private readonly authFetchService = inject(AuthFetchService);

  readonly series = signal<Series[]>([]);
  readonly loadingSeries = signal(true);
  readonly selectedSeriesId = signal<string | null>(null);

  private readonly folders = signal<ChatFolder[]>([]);
  readonly loadingFolders = signal(false);

  readonly currentFolderId = signal<string | null>(null);
  readonly selectedChildId = signal<string | null>(null);

  private readonly foldersById = computed(() => {
    const map = new Map<string, ChatFolder>();
    for (const f of this.folders()) map.set(f.id, f);
    return map;
  });

  readonly childFolders = computed(() =>
    this.folders()
      .filter(f => (f.parentFolderId ?? null) === this.currentFolderId())
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

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

  readonly destinationId = computed(() => this.selectedChildId() ?? this.currentFolderId());

  readonly destinationLabel = computed(() => {
    const destId = this.destinationId();
    if (destId === null) return this.breadcrumbs()[0].name;
    return this.foldersById().get(destId)?.name ?? 'Top level';
  });

  readonly canSave = computed(() =>
    !!this.selectedSeriesId() && (!this.data.requireFolder || this.destinationId() !== null),
  );

  hasChildren(folderId: string): boolean {
    return this.folders().some(f => (f.parentFolderId ?? null) === folderId);
  }

  async ngOnInit(): Promise<void> {
    const list = await this.fetchJson<Series[]>('/api/series');
    const active = (list ?? []).filter((s: any) => !s.deleted && !s.archived)
      .sort((a: Series, b: Series) => (a.title ?? '').localeCompare(b.title ?? ''));
    this.series.set(active);
    this.loadingSeries.set(false);
    const preselect = this.data.seriesId && active.some(s => s.id === this.data.seriesId)
      ? this.data.seriesId
      : (active.length === 1 ? active[0].id : null);
    if (preselect) await this.onSeriesChange(preselect);
  }

  async onSeriesChange(seriesId: string): Promise<void> {
    this.selectedSeriesId.set(seriesId);
    this.currentFolderId.set(null);
    this.selectedChildId.set(null);
    this.folders.set([]);
    this.loadingFolders.set(true);
    const folders = await this.fetchJson<ChatFolder[]>(`/api/chat-folders?seriesId=${encodeURIComponent(seriesId)}`);
    this.folders.set(folders ?? []);
    this.loadingFolders.set(false);
  }

  open(folderId: string): void {
    this.currentFolderId.set(folderId);
    this.selectedChildId.set(null);
  }

  navigateTo(folderId: string | null): void {
    this.currentFolderId.set(folderId);
    this.selectedChildId.set(null);
  }

  save(): void {
    const seriesId = this.selectedSeriesId();
    if (!seriesId) return;
    this.dialogRef.close({ seriesId, folderId: this.destinationId() });
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    try {
      const res = await this.authFetchService.fetch(url, {});
      if (res.ok) return await res.json() as T;
    } catch {
      // Best-effort
    }
    return null;
  }
}
