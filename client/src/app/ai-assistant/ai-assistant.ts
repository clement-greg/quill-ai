import {
  Component, inject, signal, computed, untracked, ViewChild, ElementRef, AfterViewChecked, OnInit, OnDestroy, HostListener, effect,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { parse as parseMarkdown } from 'marked';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { AiAssistantService } from '../services/ai-assistant.service';
import { SeriesContextService } from '../services/series-context.service';
import { EditorBridgeService } from '../services/editor-bridge.service';
import { EntityService } from '../services/entity.service';
import { ChapterCitation, ChatFolder, ChatMessageHighlight, ChatSessionMessage, ChatSessionSummary, FolderFile, FolderNote } from '@shared/models';
import { RichTextEditorComponent } from '../shared/rich-text-editor/rich-text-editor';
import { EntityPickerDialogComponent, EntityPickerData } from '../entity-edit/entity-picker-dialog';
import { FolderLocationPickerDialogComponent, FolderLocation, FolderLocationPickerData } from './folder-location-picker-dialog';

type SidebarItem = { kind: 'folder'; folder: ChatFolder; depth: number; trackId: string };

@Component({
  selector: 'app-ai-assistant',
  imports: [FormsModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatTooltipModule, MatSelectModule, RichTextEditorComponent],
  templateUrl: './ai-assistant.html',
  styleUrl: './ai-assistant.scss',
})
export class AiAssistantComponent implements OnInit, AfterViewChecked, OnDestroy {
  @ViewChild('messagesEl') messagesEl?: ElementRef<HTMLDivElement>;
  @ViewChild('chatInputEl') chatInputEl?: ElementRef<HTMLTextAreaElement>;

  readonly aiAssistant = inject(AiAssistantService);
  private sanitizer = inject(DomSanitizer);
  private router = inject(Router);
  readonly seriesContext = inject(SeriesContextService);
  readonly editorBridge = inject(EditorBridgeService);
  private dialog = inject(MatDialog);
  private entityService = inject(EntityService);

  // Generated-image actions
  readonly lightboxUrl = signal<string | null>(null);
  readonly imageToast = signal<string | null>(null);
  private imageToastTimer: ReturnType<typeof setTimeout> | null = null;

  readonly input = signal('');
  readonly renamingSessionId = signal<string | null>(null);
  readonly renameValue = signal('');

  // Drag state
  private draggingSessionId: string | null = null;
  private draggingFolderId: string | null = null;
  private draggingFileId: string | null = null;
  private draggingKind: 'session' | 'folder' | 'file' | null = null;

  // Folder state
  readonly expandedFolderIds = signal(new Set<string>());
  readonly selectedFolderId = signal<string | null>(null);
  readonly selectedFolderName = computed(() => {
    const id = this.selectedFolderId();
    if (!id) return null;
    if (id === 'root') return 'Root';
    return this.aiAssistant.folders().find(f => f.id === id)?.name ?? null;
  });
  readonly renamingFolderId = signal<string | null>(null);
  readonly renameFolderValue = signal('');
  readonly folderDropTargetId = signal<string | null>(null);

  // Folder context menu
  readonly folderContextMenu = signal<{ x: number; y: number; folderId: string; folderName: string } | null>(null);

  // File explorer
  readonly folderFiles = signal<FolderFile[]>([]);
  readonly filesLoading = signal(false);
  readonly selectedFileId = signal<string | null>(null);
  readonly previewFile = signal<FolderFile | null>(null);
  readonly renamingFileId = signal<string | null>(null);
  readonly renameFileValue = signal('');
  readonly fileContextMenu = signal<{ x: number; y: number; file: FolderFile } | null>(null);
  readonly fileDragOver = signal(false);
  readonly previewObjectUrl = signal<string | null>(null);
  private fileInputEl: HTMLInputElement | null = null;

  // Folder notes
  readonly folderNotes = signal<FolderNote[]>([]);
  readonly notesLoading = signal(false);
  readonly activeNote = signal<FolderNote | null>(null);
  readonly noteSaving = signal(false);
  readonly noteHasDraft = signal(false);
  readonly renamingNoteId = signal<string | null>(null);
  readonly renameNoteValue = signal('');
  readonly noteContextMenu = signal<{ x: number; y: number; note: FolderNote } | null>(null);
  private noteAutoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Flat ordered list of sidebar items (folders only)
  readonly sidebarItems = computed((): SidebarItem[] => {
    const folders = this.aiAssistant.folders();
    const expanded = this.expandedFolderIds();
    const items: SidebarItem[] = [];

    const buildLevel = (parentId: string | null, depth: number) => {
      folders
        .filter(f => (f.parentFolderId ?? null) === parentId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach(folder => {
          items.push({ kind: 'folder', folder, depth, trackId: 'f-' + folder.id });
          if (expanded.has(folder.id)) {
            buildLevel(folder.id, depth + 1);
          }
        });
    };

    buildLevel(null, 0);
    return items;
  });

  // Mobile sidebar drawer
  readonly mobileSidebarOpen = signal(false);

  // Highlight toolbar
  readonly highlightColors = [
    { value: '#ffe066', label: 'Yellow' },
    { value: '#b9fbc0', label: 'Green' },
    { value: '#b3d9ff', label: 'Blue' },
    { value: '#ffb3c6', label: 'Pink' },
  ];
  readonly highlightToolbar = signal<{ x: number; y: number; messageIndex: number } | null>(null);
  private pendingSelection: { startOffset: number; endOffset: number; messageIndex: number } | null = null;
  private readonly renderCache = new Map<string, SafeHtml>();

  // Highlight summary tray
  readonly showHighlightsSummary = signal(false);
  readonly activeHighlightId = signal<string | null>(null);
  readonly allHighlights = computed(() => {
    const session = this.aiAssistant.activeSession();
    if (!session) return [];
    const entries: Array<{ messageIndex: number; highlight: ChatMessageHighlight; excerpt: string }> = [];
    session.messages.forEach((msg, i) => {
      if (!msg.highlights?.length) return;
      const plain = this.getMessagePlainText(msg);
      for (const hl of msg.highlights) {
        const raw = plain.slice(hl.startOffset, hl.endOffset);
        const excerpt = raw.length > 90 ? raw.slice(0, 88) + '…' : raw;
        entries.push({ messageIndex: i, highlight: hl, excerpt });
      }
    });
    entries.sort((a, b) => a.messageIndex - b.messageIndex || a.highlight.startOffset - b.highlight.startOffset);
    return entries;
  });

  private shouldScrollToBottom = false;
  private scrollSmooth = false;
  private userScrolledUpDuringStream = false;
  private streamRafId: number | null = null;

  constructor() {
    // Start/stop the streaming scroll loop whenever streaming state changes
    effect(() => {
      if (this.aiAssistant.streaming()) {
        this.userScrolledUpDuringStream = false;
        this.startStreamScroll();
      } else {
        this.stopStreamScroll();
      }
    });

    // Auto-select-all text in rename input whenever a folder rename starts
    effect(() => {
      const id = this.renamingFolderId();
      if (!id) return;
      setTimeout(() => {
        const el = document.querySelector<HTMLInputElement>('.folder-rename-input');
        el?.select();
      });
    });

    // Auto-select-all text when a file rename starts
    effect(() => {
      const id = this.renamingFileId();
      if (!id) return;
      setTimeout(() => {
        const el = document.querySelector<HTMLInputElement>('.file-rename-input');
        el?.select();
      });
    });

    // Load files whenever the selected folder changes
    effect(() => {
      const folderId = this.selectedFolderId();
      if (folderId) {
        this.loadFolderFiles(folderId);
        this.loadFolderNotes(folderId);
      } else {
        this.folderFiles.set([]);
        this.folderNotes.set([]);
        this.previewFile.set(null);
        this.activeNote.set(null);
      }
    });

    // Fetch preview blob with auth headers whenever previewFile changes
    effect(() => {
      const file = this.previewFile();
      // Read previous URL without creating a reactive dependency (avoids infinite loop)
      const prev = untracked(() => this.previewObjectUrl());
      if (prev) URL.revokeObjectURL(prev);
      this.previewObjectUrl.set(null);
      if (!file) return;
      this.aiAssistant.fetchFolderFileBlob(file.folderId, file.id).then(blob => {
        this.previewObjectUrl.set(URL.createObjectURL(blob));
      });
    });
  }

  // Touch tracking — fixes iOS double-tap on draggable elements
  private touchStartY = 0;
  private lastTouchHandledAt = 0;

  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent): void {
    // Ignore right-clicks — they open the context menu, not close it
    if (event.button === 2) return;

    const toolbarEl = document.querySelector('.highlight-toolbar');
    if (toolbarEl && !toolbarEl.contains(event.target as Node)) {
      window.getSelection()?.removeAllRanges();
      this.highlightToolbar.set(null);
      this.pendingSelection = null;
    }
    // Close folder context menu when clicking outside it
    const menuEl = document.querySelector('.folder-context-menu');
    if (menuEl && !menuEl.contains(event.target as Node)) {
      this.folderContextMenu.set(null);
    }
    // Close file context menu when clicking outside it
    const fileMenuEl = document.querySelector('.file-context-menu');
    if (fileMenuEl && !fileMenuEl.contains(event.target as Node)) {
      this.fileContextMenu.set(null);
    }
    // Close note context menu when clicking outside it
    const noteMenuEl = document.querySelector('.note-context-menu');
    if (noteMenuEl && !noteMenuEl.contains(event.target as Node)) {
      this.noteContextMenu.set(null);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.lightboxUrl()) {
      event.preventDefault();
      this.closeLightbox();
      return;
    }
    if (event.key !== 'Delete') return;
    // Delete selected file
    const fileId = this.selectedFileId();
    if (fileId && !this.renamingFileId()) {
      const folderId = this.selectedFolderId();
      if (folderId) {
        event.preventDefault();
        this.deleteFile(fileId, folderId);
        return;
      }
    }
    // Delete selected empty folder
    const folderId = this.selectedFolderId();
    if (!folderId) return;
    if (this.renamingFolderId() || this.renamingSessionId()) return;
    if (this.isFolderEmpty(folderId)) {
      event.preventDefault();
      this.deleteFolder(folderId);
    }
  }

  onSessionTouchStart(event: TouchEvent): void {
    this.touchStartY = event.touches[0].clientY;
  }

  onSessionTouchEnd(id: string, event: TouchEvent): void {
    const dy = Math.abs(event.changedTouches[0].clientY - this.touchStartY);
    if (dy > 10) return; // was a scroll, not a tap
    event.preventDefault(); // suppress the ghost click that follows
    this.lastTouchHandledAt = Date.now();
    this.openSession(id);
  }

  onSessionClick(id: string): void {
    if (Date.now() - this.lastTouchHandledAt < 600) return; // already handled by touchend
    this.openSession(id);
  }

  readonly activeSessionId = computed(() => this.aiAssistant.activeSession()?.id ?? null);

  ngOnInit(): void {
    this.aiAssistant.loadAllSeries().then(() => {
      // Auto-detect series from the page the user is currently viewing
      this.aiAssistant.autoDetectSeries(this.seriesContext.currentSeriesId());
    });
  }

  ngOnDestroy(): void {
    this.stopStreamScroll();
    const url = this.previewObjectUrl();
    if (url) URL.revokeObjectURL(url);
    if (this.imageToastTimer) clearTimeout(this.imageToastTimer);
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom) {
      this.scrollToBottom(this.scrollSmooth);
      this.shouldScrollToBottom = false;
      this.scrollSmooth = false;
    }
  }

  async newChat(): Promise<void> {
    this.aiAssistant.startPendingSession(this.selectedFolderId());
    this.selectedFolderId.set(null);
    this.input.set('');
    this.mobileSidebarOpen.set(false);
    this.showHighlightsSummary.set(false);
    this.activeHighlightId.set(null);
    this.shouldScrollToBottom = true;
    setTimeout(() => this.chatInputEl?.nativeElement.focus());
  }

  async openSession(id: string): Promise<void> {
    await this.aiAssistant.openSession(id);
    // Keep the session's folder selected so it stays highlighted in the sidebar
    const session = this.aiAssistant.activeSession();
    this.selectedFolderId.set(session?.folderId ?? null);
    this.input.set('');
    this.mobileSidebarOpen.set(false);
    this.showHighlightsSummary.set(false);
    this.activeHighlightId.set(null);
    // First pass: scroll after Angular renders the messages
    setTimeout(() => {
      this.scrollToBottom(true);
      this.chatInputEl?.nativeElement.focus();
      // Second pass: scroll again after images/layout settle
      setTimeout(() => this.scrollToBottom(true), 400);
    });
  }

  async send(): Promise<void> {
    const text = this.input().trim();
    if (!text || this.aiAssistant.streaming()) return;
    this.input.set('');
    this.userScrolledUpDuringStream = false;
    this.shouldScrollToBottom = true;
    await this.aiAssistant.sendMessage(text);
    this.shouldScrollToBottom = true;
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  async togglePin(session: ChatSessionSummary, event: Event): Promise<void> {
    event.stopPropagation();
    await this.aiAssistant.togglePin(session.id);
  }

  async deleteSession(sessionId: string, event: Event): Promise<void> {
    event.stopPropagation();
    await this.aiAssistant.deleteSession(sessionId);
  }

  startRename(session: ChatSessionSummary, event: Event): void {
    event.stopPropagation();
    this.renamingSessionId.set(session.id);
    this.renameValue.set(session.name);
  }

  async commitRename(sessionId: string): Promise<void> {
    const name = this.renameValue().trim();
    if (name) {
      await this.aiAssistant.renameSession(sessionId, name);
    }
    this.renamingSessionId.set(null);
  }

  cancelRename(): void {
    this.renamingSessionId.set(null);
  }

  onRenameKeyDown(event: KeyboardEvent, sessionId: string): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitRename(sessionId);
    } else if (event.key === 'Escape') {
      this.cancelRename();
    }
  }

  // ── Session drag (from file explorer) ──────────────────────────────────

  onDragStart(event: DragEvent, sessionId: string): void {
    this.draggingSessionId = sessionId;
    this.draggingFolderId = null;
    this.draggingFileId = null;
    this.draggingKind = 'session';
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', sessionId);
    }
  }

  onFileDragStart(event: DragEvent, fileId: string): void {
    event.stopPropagation();
    this.draggingFileId = fileId;
    this.draggingSessionId = null;
    this.draggingFolderId = null;
    this.draggingKind = 'file';
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', fileId);
    }
  }

  // ── Sidebar root drop zone (empty space below items) ────────────────────

  readonly isSidebarRootDragOver = signal(false);

  onSidebarRootDragOver(event: DragEvent): void {
    if (this.draggingKind !== 'folder') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.isSidebarRootDragOver.set(true);
  }

  onSidebarRootDragLeave(): void {
    this.isSidebarRootDragOver.set(false);
  }

  async onDropToSidebarRoot(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isSidebarRootDragOver.set(false);
    if (this.draggingKind === 'folder' && this.draggingFolderId) {
      await this.aiAssistant.moveFolderToFolder(this.draggingFolderId, null);
      this.draggingFolderId = null;
      this.draggingKind = null;
    }
  }



  // ── Folder drag ─────────────────────────────────────────────────────────

  onFolderDragStart(event: DragEvent, folderId: string): void {
    event.stopPropagation();
    this.draggingFolderId = folderId;
    this.draggingSessionId = null;
    this.draggingKind = 'folder';
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', folderId);
    }
  }

  onFolderDragOver(event: DragEvent, folderId: string): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.draggingKind === 'folder') {
      const dragId = this.draggingFolderId;
      if (!dragId || dragId === folderId || this.isFolderDescendant(folderId, dragId)) return;
    }
    if (this.draggingKind === null && !event.dataTransfer?.types.includes('Files')) return;
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.folderDropTargetId.set(folderId);
  }

  onFolderDragLeave(folderId: string): void {
    if (this.folderDropTargetId() === folderId) {
      this.folderDropTargetId.set(null);
    }
  }

  async onDropToFolder(event: DragEvent, folderId: string): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.folderDropTargetId.set(null);

    // OS file drop
    if (event.dataTransfer?.types.includes('Files') && this.draggingKind === null) {
      await this.onFolderDropFiles(event, folderId);
      return;
    }

    if (this.draggingKind === 'session' && this.draggingSessionId) {
      await this.aiAssistant.moveSessionToFolder(this.draggingSessionId, folderId);
      if (folderId === this.selectedFolderId()) {
        // Reload file explorer content for current folder
        this.loadFolderFiles(folderId);
      }
      this.expandedFolderIds.update(s => { const n = new Set(s); n.add(folderId); return n; });
      this.draggingSessionId = null;
    } else if (this.draggingKind === 'file' && this.draggingFileId) {
      const fileId = this.draggingFileId;
      const currentFolderId = this.folderFiles().find(f => f.id === fileId)?.folderId
        ?? this.selectedFolderId() ?? '';
      if (currentFolderId !== folderId) {
        await this.aiAssistant.moveFolderFile(currentFolderId, fileId, folderId);
        // Remove from current folder view
        this.folderFiles.update(fs => fs.filter(f => f.id !== fileId));
        if (this.selectedFileId() === fileId) this.selectedFileId.set(null);
        if (this.previewFile()?.id === fileId) { this.previewFile.set(null); }
      }
      this.draggingFileId = null;
    } else if (this.draggingKind === 'folder' && this.draggingFolderId) {
      const dragId = this.draggingFolderId;
      if (dragId !== folderId && !this.isFolderDescendant(folderId, dragId)) {
        await this.aiAssistant.moveFolderToFolder(dragId, folderId);
        this.expandedFolderIds.update(s => { const n = new Set(s); n.add(folderId); return n; });
      }
      this.draggingFolderId = null;
    }
    this.draggingKind = null;
  }

  /** Returns true if `potentialDescendantId` is a descendant of `ancestorId`. */
  private isFolderDescendant(potentialDescendantId: string, ancestorId: string): boolean {
    const folders = this.aiAssistant.folders();
    let current = folders.find(f => f.id === potentialDescendantId);
    while (current?.parentFolderId) {
      if (current.parentFolderId === ancestorId) return true;
      current = folders.find(f => f.id === current!.parentFolderId!);
    }
    return false;
  }

  // ── Folder CRUD ──────────────────────────────────────────────────────────

  /** Creates a folder. If a folder is currently selected, creates a subfolder inside it. */
  async createFolderFromHeader(): Promise<void> {
    const parentId = this.selectedFolderId();
    if (parentId) {
      this.expandedFolderIds.update(s => { const n = new Set(s); n.add(parentId); return n; });
    }
    const folder = await this.aiAssistant.createFolder('New Folder', parentId);
    if (folder) {
      this.renamingFolderId.set(folder.id);
      this.renameFolderValue.set('New Folder');
    }
  }

  async createSubfolder(parentFolderId: string, event: Event): Promise<void> {
    event.stopPropagation();
    this.expandedFolderIds.update(s => { const n = new Set(s); n.add(parentFolderId); return n; });
    const folder = await this.aiAssistant.createFolder('New Folder', parentFolderId);
    if (folder) {
      this.renamingFolderId.set(folder.id);
      this.renameFolderValue.set('New Folder');
    }
  }

  startRenameFolder(folderId: string, currentName: string, event: Event): void {
    event.stopPropagation();
    this.folderContextMenu.set(null);
    this.renamingFolderId.set(folderId);
    this.renameFolderValue.set(currentName);
  }

  onFolderContextMenu(event: MouseEvent, folderId: string, folderName: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectedFolderId.set(folderId);
    this.folderContextMenu.set({ x: event.clientX, y: event.clientY, folderId, folderName });
  }

  async commitFolderRename(folderId: string): Promise<void> {
    const name = this.renameFolderValue().trim();
    if (name) await this.aiAssistant.renameFolder(folderId, name);
    this.renamingFolderId.set(null);
  }

  cancelFolderRename(): void {
    this.renamingFolderId.set(null);
  }

  onRenameFolderKeyDown(event: KeyboardEvent, folderId: string): void {
    if (event.key === 'Enter') { event.preventDefault(); this.commitFolderRename(folderId); }
    else if (event.key === 'Escape') { this.cancelFolderRename(); }
  }

  async deleteFolder(folderId: string, event?: Event): Promise<void> {
    event?.stopPropagation();
    await this.aiAssistant.deleteFolder(folderId);
    this.expandedFolderIds.update(s => { const n = new Set(s); n.delete(folderId); return n; });
    if (this.selectedFolderId() === folderId) this.selectedFolderId.set(null);
  }

  isFolderEmpty(folderId: string): boolean {
    const hasChildFolder = this.aiAssistant.folders().some(f => f.parentFolderId === folderId);
    const hasSession = this.aiAssistant.sessions().some(s => s.folderId === folderId);
    return !hasChildFolder && !hasSession;
  }

  toggleFolderExpanded(folderId: string): void {
    this.selectedFolderId.set(folderId);
    this.aiAssistant.closeActiveSession();
    this.expandedFolderIds.update(s => {
      const n = new Set(s);
      if (n.has(folderId)) n.delete(folderId); else n.add(folderId);
      return n;
    });
  }

  // ── Folder notes ────────────────────────────────────────────────────────

  async loadFolderNotes(folderId: string): Promise<void> {
    this.notesLoading.set(true);
    const notes = await this.aiAssistant.listFolderNotes(folderId);
    this.folderNotes.set(notes);
    this.notesLoading.set(false);
  }

  async newNote(): Promise<void> {
    const folderId = this.selectedFolderId() ?? 'root';
    if (folderId === 'root') this.selectedFolderId.set('root');
    const seriesId = this.seriesContext.currentSeriesId() ?? undefined;
    const note = await this.aiAssistant.createFolderNote(folderId, seriesId);
    if (!note) return;
    this.folderNotes.update(list => [note, ...list]);
    this.openNote(note);
  }

  async openNote(note: FolderNote): Promise<void> {
    // Load full content if stub
    const full = await this.aiAssistant.getFolderNote(note.folderId, note.id);
    this.activeNote.set(full ?? note);
    this.noteHasDraft.set(false);
  }

  closeNote(): void {
    if (this.noteAutoSaveTimer) { clearTimeout(this.noteAutoSaveTimer); this.noteAutoSaveTimer = null; }
    this.activeNote.set(null);
    this.noteHasDraft.set(false);
  }

  onNoteContentChange(html: string): void {
    if (this.noteAutoSaveTimer) clearTimeout(this.noteAutoSaveTimer);
    this.noteAutoSaveTimer = setTimeout(() => {
      this.saveNote(html);
    }, 1200);
    this.noteHasDraft.set(true);
  }

  async saveNote(content?: string): Promise<void> {
    const note = this.activeNote();
    if (!note) return;
    const html = content ?? '';
    if (this.noteAutoSaveTimer) { clearTimeout(this.noteAutoSaveTimer); this.noteAutoSaveTimer = null; }
    this.noteSaving.set(true);
    const updated = await this.aiAssistant.saveFolderNote(note.folderId, note.id, html);
    if (updated) {
      this.activeNote.set(updated);
      this.folderNotes.update(list => list.map(n => n.id === updated.id ? { ...n, name: updated.name } : n));
    }
    this.noteSaving.set(false);
    this.noteHasDraft.set(false);
  }

  onNoteContextMenu(event: MouseEvent, note: FolderNote): void {
    event.preventDefault();
    event.stopPropagation();
    this.noteContextMenu.set({ x: event.clientX, y: event.clientY, note });
  }

  startRenameNote(note: FolderNote): void {
    this.noteContextMenu.set(null);
    this.renamingNoteId.set(note.id);
    this.renameNoteValue.set(note.name);
    setTimeout(() => document.querySelector<HTMLInputElement>('.note-rename-input')?.select());
  }

  async commitNoteRename(noteId: string): Promise<void> {
    const name = this.renameNoteValue().trim();
    const note = this.folderNotes().find(n => n.id === noteId);
    if (name && note) {
      await this.aiAssistant.renameFolderNote(note.folderId, noteId, name);
      this.folderNotes.update(list => list.map(n => n.id === noteId ? { ...n, name } : n));
      const active = this.activeNote();
      if (active?.id === noteId) this.activeNote.set({ ...active, name });
    }
    this.renamingNoteId.set(null);
  }

  cancelNoteRename(): void { this.renamingNoteId.set(null); }

  onRenameNoteKeyDown(event: KeyboardEvent, noteId: string): void {
    if (event.key === 'Enter') { event.preventDefault(); this.commitNoteRename(noteId); }
    else if (event.key === 'Escape') this.cancelNoteRename();
  }

  async deleteNote(note: FolderNote): Promise<void> {
    this.noteContextMenu.set(null);
    await this.aiAssistant.deleteFolderNote(note.folderId, note.id);
    this.folderNotes.update(list => list.filter(n => n.id !== note.id));
    if (this.activeNote()?.id === note.id) this.activeNote.set(null);
  }

  // ── File explorer ────────────────────────────────────────────────────────

  async loadFolderFiles(folderId: string): Promise<void> {
    this.filesLoading.set(true);
    this.previewFile.set(null);
    this.selectedFileId.set(null);
    const files = await this.aiAssistant.listFolderFiles(folderId);
    this.folderFiles.set(files);
    this.filesLoading.set(false);
  }

  triggerFileUpload(): void {
    if (!this.fileInputEl) {
      this.fileInputEl = document.createElement('input');
      this.fileInputEl.type = 'file';
      this.fileInputEl.multiple = true;
      this.fileInputEl.addEventListener('change', async () => {
        const files = Array.from(this.fileInputEl!.files ?? []);
        await this.uploadFiles(files);
        this.fileInputEl!.value = '';
      });
    }
    this.fileInputEl.click();
  }

  async uploadFiles(files: File[]): Promise<void> {
    const folderId = this.selectedFolderId() ?? 'root';
    if (!files.length) return;
    if (folderId === 'root') this.selectedFolderId.set('root');
    this.filesLoading.set(true);
    const results = await Promise.all(files.map(f => this.aiAssistant.uploadFolderFile(folderId, f)));
    this.folderFiles.update(list => [
      ...list,
      ...(results.filter((r): r is FolderFile => r !== null)),
    ]);
    this.filesLoading.set(false);
  }

  onExplorerDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      this.fileDragOver.set(true);
    }
  }

  onExplorerDragLeave(): void {
    this.fileDragOver.set(false);
  }

  async onExplorerDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.fileDragOver.set(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    await this.uploadFiles(files);
  }

  // Sidebar folder row drop: accept OS files dragged onto a folder
  async onFolderDropFiles(event: DragEvent, folderId: string): Promise<void> {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    this.folderDropTargetId.set(null);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    // Temporarily switch selected folder so uploads go to the right place
    const prev = this.selectedFolderId();
    this.selectedFolderId.set(folderId);
    this.expandedFolderIds.update(s => { const n = new Set(s); n.add(folderId); return n; });
    this.filesLoading.set(true);
    const results = await Promise.all(files.map(f => this.aiAssistant.uploadFolderFile(folderId, f)));
    if (prev === folderId) {
      this.folderFiles.update(list => [
        ...list,
        ...(results.filter((r): r is FolderFile => r !== null)),
      ]);
    }
    this.filesLoading.set(false);
  }

  selectFile(file: FolderFile): void {
    this.selectedFileId.set(file.id);
    if (this.isBrowserPreviewable(file.contentType)) {
      this.previewFile.set(file);
    } else {
      this.previewFile.set(null);
    }
  }

  isBrowserPreviewable(contentType: string): boolean {
    return (
      contentType.startsWith('image/') ||
      contentType === 'application/pdf' ||
      contentType.startsWith('text/') ||
      contentType === 'text/html'
    );
  }

  fileIcon(contentType: string): string {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType === 'application/pdf') return 'picture_as_pdf';
    if (contentType.startsWith('text/')) return 'article';
    if (contentType.includes('word')) return 'description';
    if (contentType.includes('spreadsheet') || contentType.includes('excel')) return 'table_chart';
    if (contentType.includes('zip') || contentType.includes('compressed')) return 'folder_zip';
    if (contentType.includes('audio')) return 'audio_file';
    if (contentType.includes('video')) return 'video_file';
    return 'insert_drive_file';
  }

  formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async deleteFile(fileId: string, folderId: string): Promise<void> {
    await this.aiAssistant.deleteFolderFile(folderId, fileId);
    this.folderFiles.update(list => list.filter(f => f.id !== fileId));
    if (this.selectedFileId() === fileId) {
      this.selectedFileId.set(null);
      this.previewFile.set(null);
    }
  }

  onFileContextMenu(event: MouseEvent, file: FolderFile): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectedFileId.set(file.id);
    this.fileContextMenu.set({ x: event.clientX, y: event.clientY, file });
  }

  startRenameFile(file: FolderFile): void {
    this.fileContextMenu.set(null);
    this.renamingFileId.set(file.id);
    this.renameFileValue.set(file.name);
  }

  async commitFileRename(fileId: string): Promise<void> {
    const name = this.renameFileValue().trim();
    if (name) {
      const folderId = this.folderFiles().find(f => f.id === fileId)?.folderId;
      if (folderId) {
        await this.aiAssistant.renameFolderFile(folderId, fileId, name);
        this.folderFiles.update(list => list.map(f => f.id === fileId ? { ...f, name } : f));
        const prev = this.previewFile();
        if (prev?.id === fileId) this.previewFile.set({ ...prev, name });
      }
    }
    this.renamingFileId.set(null);
  }

  cancelFileRename(): void {
    this.renamingFileId.set(null);
  }

  onRenameFileKeyDown(event: KeyboardEvent, fileId: string): void {
    if (event.key === 'Enter') { event.preventDefault(); this.commitFileRename(fileId); }
    else if (event.key === 'Escape') { this.cancelFileRename(); }
  }

  previewUrl(file: FolderFile): string {
    return this.aiAssistant.folderFilePreviewUrl(file.folderId, file.id);
  }

  safePreviewObjectUrl(): SafeHtml | null {
    const url = this.previewObjectUrl();
    if (!url) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  downloadUrl(file: FolderFile): string {
    return this.aiAssistant.folderFileDownloadUrl(file.folderId, file.id);
  }

  proxyUrl(azureUrl: string | undefined): string | null {    if (!azureUrl) return null;
    const filename = azureUrl.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }

  // ── Generated-image actions ─────────────────────────────────────────────

  openLightbox(imageUrl: string): void {
    this.lightboxUrl.set(this.proxyUrl(imageUrl));
  }

  closeLightbox(): void {
    this.lightboxUrl.set(null);
  }

  private showImageToast(message: string): void {
    this.imageToast.set(message);
    if (this.imageToastTimer) clearTimeout(this.imageToastTimer);
    this.imageToastTimer = setTimeout(() => this.imageToast.set(null), 3000);
  }

  /** Save a generated image into a chosen entity's photo gallery. */
  async saveToGallery(msg: ChatSessionMessage): Promise<void> {
    if (!msg.imageUrl) return;
    const seriesId = this.aiAssistant.activeSession()?.seriesId ?? this.aiAssistant.selectedSeriesId();
    const ref = this.dialog.open(EntityPickerDialogComponent, {
      data: { seriesId } satisfies EntityPickerData,
      autoFocus: false,
    });
    const entity = await firstValueFrom(ref.afterClosed());
    if (!entity) return;
    try {
      await firstValueFrom(
        this.entityService.addPhoto(entity.id, msg.imageUrl, msg.thumbnailUrl ?? msg.imageUrl),
      );
      this.showImageToast(`Saved to ${entity.name}'s gallery.`);
    } catch {
      this.showImageToast('Could not save to gallery.');
    }
  }

  /** Save a generated image as a file in a chosen Resource Manager folder. */
  async saveToResourceManager(msg: ChatSessionMessage): Promise<void> {
    if (!msg.imageUrl) return;
    const seriesId = this.aiAssistant.activeSession()?.seriesId ?? this.aiAssistant.selectedSeriesId();
    const ref = this.dialog.open(FolderLocationPickerDialogComponent, {
      data: { seriesId, requireFolder: true } satisfies FolderLocationPickerData,
      autoFocus: false,
    });
    const location: FolderLocation | undefined = await firstValueFrom(ref.afterClosed());
    if (!location?.folderId) return;
    try {
      const url = this.proxyUrl(msg.imageUrl);
      if (!url) return;
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], 'generated-image.png', { type: blob.type || 'image/png' });
      const saved = await this.aiAssistant.uploadFolderFile(location.folderId, file);
      this.showImageToast(saved ? 'Saved to Resource Manager.' : 'Could not save to Resource Manager.');
    } catch {
      this.showImageToast('Could not save to Resource Manager.');
    }
  }

  // ── Highlight summary navigation ────────────────────────────────────────

  navigateToHighlight(messageIndex: number, highlightId: string): void {
    this.activeHighlightId.set(highlightId);
    const container = this.messagesEl?.nativeElement;
    if (!container) return;
    const markEl = container.querySelector(`mark[data-highlight-id="${highlightId}"]`) as HTMLElement | null;
    const target = markEl ?? (container.querySelector(`[data-msg-index="${messageIndex}"]`) as HTMLElement | null);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (markEl) {
      markEl.classList.remove('highlight-flash');
      // Force reflow so re-adding the class re-triggers the animation
      void markEl.offsetWidth;
      markEl.classList.add('highlight-flash');
    }
  }

  navigateToNextHighlight(): void {
    const all = this.allHighlights();
    if (!all.length) return;
    const activeId = this.activeHighlightId();
    const idx = all.findIndex(e => e.highlight.id === activeId);
    const next = all[(idx + 1) % all.length];
    this.navigateToHighlight(next.messageIndex, next.highlight.id);
  }

  navigateToPrevHighlight(): void {
    const all = this.allHighlights();
    if (!all.length) return;
    const activeId = this.activeHighlightId();
    const idx = all.findIndex(e => e.highlight.id === activeId);
    const prev = all[(idx - 1 + all.length) % all.length];
    this.navigateToHighlight(prev.messageIndex, prev.highlight.id);
  }

  async deleteHighlight(messageIndex: number, highlightId: string, event: Event): Promise<void> {
    event.stopPropagation();
    if (this.activeHighlightId() === highlightId) {
      this.activeHighlightId.set(null);
    }
    await this.aiAssistant.removeHighlight(messageIndex, highlightId);
  }

  private getMessagePlainText(msg: ChatSessionMessage): string {
    const rawHtml = parseMarkdown(msg.text) as string;
    const div = document.createElement('div');
    div.innerHTML = rawHtml;
    return div.textContent ?? '';
  }

  onMessagesMouseUp(): void {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      this.highlightToolbar.set(null);
      this.pendingSelection = null;
      return;
    }

    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const markdownEl = ancestor?.closest('.chat-markdown') as HTMLElement | null;
    if (!markdownEl) {
      this.highlightToolbar.set(null);
      this.pendingSelection = null;
      return;
    }

    const msgEl = markdownEl.closest('[data-msg-index]') as HTMLElement | null;
    const messageIndex = msgEl ? parseInt(msgEl.dataset['msgIndex'] ?? '-1', 10) : -1;
    if (messageIndex < 0) {
      this.highlightToolbar.set(null);
      this.pendingSelection = null;
      return;
    }

    const startOffset = this.getTextOffset(markdownEl, range.startContainer, range.startOffset);
    const endOffset = this.getTextOffset(markdownEl, range.endContainer, range.endOffset);
    if (startOffset >= endOffset) {
      this.highlightToolbar.set(null);
      this.pendingSelection = null;
      return;
    }

    this.pendingSelection = { startOffset, endOffset, messageIndex };

    const rect = range.getBoundingClientRect();
    const toolbarWidth = 200;
    const toolbarHeight = 44;
    const margin = 8;

    let x = rect.left + rect.width / 2 - toolbarWidth / 2;
    let y = rect.top - toolbarHeight - margin;

    x = Math.max(margin, Math.min(x, window.innerWidth - toolbarWidth - margin));
    if (y < margin) {
      y = rect.bottom + margin;
    }
    y = Math.min(y, window.innerHeight - toolbarHeight - margin);

    this.highlightToolbar.set({ x, y, messageIndex });
  }

  private getTextOffset(root: Node, targetNode: Node, targetOffset: number): number {
    let offset = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node === targetNode) return offset + targetOffset;
      offset += node.textContent?.length ?? 0;
    }
    return offset + targetOffset;
  }

  async addHighlight(color: string): Promise<void> {
    if (!this.pendingSelection) return;
    const { startOffset, endOffset, messageIndex } = this.pendingSelection;
    const highlight: ChatMessageHighlight = {
      id: crypto.randomUUID(),
      startOffset,
      endOffset,
      color,
    };
    this.highlightToolbar.set(null);
    this.pendingSelection = null;
    window.getSelection()?.removeAllRanges();
    await this.aiAssistant.addHighlight(messageIndex, highlight);
  }

  async eraseHighlights(): Promise<void> {
    if (!this.pendingSelection) return;
    const { startOffset, endOffset, messageIndex } = this.pendingSelection;
    this.highlightToolbar.set(null);
    this.pendingSelection = null;
    window.getSelection()?.removeAllRanges();
    await this.aiAssistant.removeHighlightsInRange(messageIndex, startOffset, endOffset);
  }

  copyToEditor(): void {
    const text = window.getSelection()?.toString().trim();
    if (!text) return;
    this.editorBridge.insertText(text);
    this.highlightToolbar.set(null);
    this.pendingSelection = null;
    window.getSelection()?.removeAllRanges();
  }

  renderMessageHtml(msg: ChatSessionMessage, absoluteIndex: number): SafeHtml {
    const highlights = msg.highlights ?? [];
    const sources = msg.sources ?? [];
    const cacheKey = `${absoluteIndex}:${msg.text}:${JSON.stringify(highlights)}:${JSON.stringify(sources)}`;
    const cached = this.renderCache.get(cacheKey);
    if (cached) return cached;
    const rawHtml = parseMarkdown(msg.text) as string;
    let html = highlights.length
      ? this.applyHighlightsToHtml(rawHtml, highlights, absoluteIndex)
      : rawHtml;
    if (sources.length) html = this.decorateCitations(html, sources);
    const result = this.sanitizer.bypassSecurityTrustHtml(html);
    this.renderCache.set(cacheKey, result);
    return result;
  }

  /**
   * Turns inline `[n]` markers into clickable citation links and appends a
   * Sources footer, both navigating to the referenced chapter. Links carry a
   * data-chapter-id consumed by onCitationClick via event delegation.
   */
  private decorateCitations(html: string, sources: ChapterCitation[]): string {
    const byNumber = new Map(sources.map(s => [s.n, s]));
    // Match a single [1] or grouped [1][2] / [1, 2] citations and link each number.
    const withInline = html.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?:\s*\[(\d+(?:\s*,\s*\d+)*)\])*/g, match => {
      const numbers = match.match(/\d+/g) ?? [];
      const links = numbers
        .map(digits => {
          const source = byNumber.get(Number(digits));
          if (!source) return `[${digits}]`;
          const title = this.escapeHtml(source.title);
          return `<a class="chapter-citation" data-chapter-id="${this.escapeHtml(source.chapterId)}" title="Go to ${title}">[${digits}]</a>`;
        })
        .join('');
      return links;
    });
    const links = sources
      .map(s => `<a class="chapter-citation" data-chapter-id="${this.escapeHtml(s.chapterId)}">${s.n}. ${this.escapeHtml(s.title)}</a>`)
      .join('');
    return `${withInline}<div class="chat-sources"><span class="chat-sources-label">Sources</span>${links}</div>`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Event delegation for citation links rendered via [innerHTML]. */
  onCitationClick(event: MouseEvent): void {
    const target = (event.target as HTMLElement | null)?.closest('[data-chapter-id]') as HTMLElement | null;
    if (!target) return;
    const chapterId = target.dataset['chapterId'];
    if (!chapterId) return;
    event.preventDefault();
    this.router.navigate(['/chapters', chapterId, 'edit']);
  }

  private applyHighlightsToHtml(rawHtml: string, highlights: ChatMessageHighlight[], msgIndex: number): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<body>${rawHtml}</body>`, 'text/html');
    const root = doc.body;
    // Process highest startOffset first to avoid cumulative offset drift
    const sorted = [...highlights].sort((a, b) => b.startOffset - a.startOffset);
    for (const hl of sorted) {
      this.applyHighlightNode(root, hl, msgIndex);
    }
    return root.innerHTML;
  }

  private applyHighlightNode(root: Element, hl: ChatMessageHighlight, msgIndex: number): void {
    const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

    let cumOffset = 0;
    const toWrap: { node: Text; from: number; to: number }[] = [];

    for (const node of textNodes) {
      const len = node.length;
      const nodeStart = cumOffset;
      const nodeEnd = cumOffset + len;
      if (nodeEnd <= hl.startOffset || nodeStart >= hl.endOffset) {
        cumOffset += len;
        continue;
      }
      const from = Math.max(0, hl.startOffset - nodeStart);
      const to = Math.min(len, hl.endOffset - nodeStart);
      toWrap.push({ node, from, to });
      cumOffset += len;
    }

    // Apply right-to-left within each text node to keep earlier offsets valid
    for (const { node, from, to } of [...toWrap].reverse()) {
      const parent = node.parentNode;
      if (!parent) continue;
      try {
        const after = node.splitText(to);
        const highlighted = node.splitText(from);
        const mark = root.ownerDocument!.createElement('mark');
        mark.className = 'chat-highlight';
        mark.style.background = hl.color;
        mark.dataset['highlightId'] = hl.id;
        mark.dataset['msgIndex'] = String(msgIndex);
        parent.insertBefore(mark, after);
        mark.appendChild(highlighted);
      } catch {
        // Skip if DOM structure prevents wrapping (e.g. complex overlap)
      }
    }
  }

  private scrollToBottom(smooth = false): void {
    if (this.messagesEl) {
      const el = this.messagesEl.nativeElement;
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
    }
  }

  onMessagesScroll(): void {
    if (!this.aiAssistant.streaming() || !this.messagesEl) return;
    const el = this.messagesEl.nativeElement;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // If user scrolled more than 80px away from the bottom, stop auto-scrolling
    if (distanceFromBottom > 80) {
      this.userScrolledUpDuringStream = true;
    }
  }

  private startStreamScroll(): void {
    const tick = () => {
      if (!this.aiAssistant.streaming()) return;
      if (!this.userScrolledUpDuringStream && this.messagesEl) {
        const el = this.messagesEl.nativeElement;
        el.scrollTop = el.scrollHeight;
      }
      this.streamRafId = requestAnimationFrame(tick);
    };
    this.streamRafId = requestAnimationFrame(tick);
  }

  private stopStreamScroll(): void {
    if (this.streamRafId !== null) {
      cancelAnimationFrame(this.streamRafId);
      this.streamRafId = null;
    }
  }
}
