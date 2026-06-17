import {
  Component,
  ChangeDetectionStrategy,
  OnDestroy,
  inject,
  signal,
  computed,
  afterNextRender,
  viewChild,
  ElementRef,
  NgZone,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import Konva from 'konva';
import { v4 as uuidv4 } from 'uuid';
import { SeriesMap, MapElement, ImageElement, PathElement } from '@shared/models/map.model';
import { MapAsset } from '@shared/models/map-asset.model';
import { MapService } from '../map.service';
import { MapAssetService } from '../map-asset.service';
import { MapElementRegistry } from '../map-element.registry';
import { SeriesContextService } from '../../services/series-context.service';
import { HeaderService } from '../../services/header.service';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

@Component({
  selector: 'app-map-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    MatTooltipModule,
  ],
  templateUrl: './map-editor.html',
  styleUrl: './map-editor.scss',
})
export class MapEditorComponent implements OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private zone = inject(NgZone);
  private mapService = inject(MapService);
  private assetService = inject(MapAssetService);
  private registry = inject(MapElementRegistry);
  private seriesContext = inject(SeriesContextService);
  private headerService = inject(HeaderService);

  readonly stageContainer = viewChild<ElementRef<HTMLDivElement>>('stageContainer');

  // ----- UI state (read by the template) -----
  readonly loading = signal(true);
  readonly title = signal('');
  readonly assets = signal<MapAsset[]>([]);
  readonly elements = signal<MapElement[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly mode = signal<'select' | string>('select'); // 'select' or a path preset typeId
  readonly drawing = signal(false);
  readonly uploading = signal(false);
  readonly saveStatus = signal<SaveStatus>('idle');
  readonly bgColor = signal('#e8dcc0');
  readonly gridSize = signal(50);

  readonly pathPresets = this.registry.pathPresets;
  // Elements listed top-of-stack first for the accessible element list.
  readonly elementsByZ = computed(() =>
    [...this.elements()].sort((a, b) => b.z - a.z),
  );
  readonly selectedElement = computed(() =>
    this.elements().find(e => e.id === this.selectedId()) ?? null,
  );

  // ----- Konva internals (live outside Angular's zone) -----
  private map?: SeriesMap;
  private stage?: Konva.Stage;
  private bgLayer?: Konva.Layer;
  private elementLayer?: Konva.Layer;
  private overlayLayer?: Konva.Layer;
  private transformer?: Konva.Transformer;
  /** elementId -> { node, label } so we can move labels with their elements. */
  private nodes = new Map<string, { node: Konva.Node; label?: Konva.Text }>();
  private imageCache = new Map<string, HTMLImageElement>();
  private draftPoints: { x: number; y: number }[] = [];
  private draftPreview: { x: number; y: number } | null = null;
  private draftLine?: Konva.Line;

  private stageReady = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.mapService.getById(id).subscribe({
        next: map => {
          this.map = map;
          this.title.set(map.title);
          this.elements.set(map.elements ?? []);
          this.bgColor.set(map.background.color);
          this.gridSize.set(map.background.gridSize ?? 0);
          this.loading.set(false);
          this.seriesContext.set(map.seriesId);
          this.headerService.set([
            { label: 'Maps', link: '/series/' + map.seriesId + '/maps' },
            { label: map.title },
          ]);
          this.loadAssets(map.seriesId);
          this.tryRender();
        },
        error: () => {
          this.loading.set(false);
          this.saveStatus.set('error');
        },
      });
    }

    afterNextRender(() => {
      this.zone.runOutsideAngular(() => this.buildStage());
      document.addEventListener('keydown', this.onKeyDown);
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    document.removeEventListener('keydown', this.onKeyDown);
    this.stage?.destroy();
    this.headerService.clearAll();
  }

  // ===================== Stage setup =====================

  private buildStage(): void {
    const el = this.stageContainer()?.nativeElement;
    if (!el || this.stage) return;

    this.stage = new Konva.Stage({
      container: el,
      width: el.clientWidth,
      height: el.clientHeight,
      draggable: true,
    });
    this.bgLayer = new Konva.Layer();
    this.elementLayer = new Konva.Layer();
    this.overlayLayer = new Konva.Layer();
    this.stage.add(this.bgLayer, this.elementLayer, this.overlayLayer);

    this.transformer = new Konva.Transformer({
      rotateEnabled: true,
      ignoreStroke: true,
      boundBoxFunc: (oldBox, newBox) =>
        newBox.width < 16 || newBox.height < 16 ? oldBox : newBox,
    });
    this.overlayLayer.add(this.transformer);

    // Click empty space: deselect (in select mode) or add a path point (draw mode).
    this.stage.on('click tap', e => {
      if (this.mode() !== 'select') {
        this.addDraftPoint();
        return;
      }
      if (e.target === this.stage) this.select(null);
    });
    this.stage.on('mousemove', () => {
      if (this.mode() === 'select') return;
      this.draftPreview = this.pointerPos();
      this.renderDraft();
    });
    this.stage.on('dblclick dbltap', () => {
      if (this.mode() !== 'select') this.finishPath();
    });
    this.stage.on('wheel', e => this.onWheel(e));

    // HTML5 drop from the asset palette.
    el.addEventListener('dragover', ev => ev.preventDefault());
    el.addEventListener('drop', ev => this.onDrop(ev));

    // Keep the stage sized to its container.
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.stage) return;
      this.stage.width(el.clientWidth);
      this.stage.height(el.clientHeight);
    });
    this.resizeObserver.observe(el);

    this.stageReady = true;
    this.tryRender();
  }
  private resizeObserver?: ResizeObserver;

  /** Renders once both the map data and the Konva stage are ready. */
  private tryRender(): void {
    if (!this.stageReady || !this.map) return;
    this.renderBackground();
    this.renderElements();
    this.fitView();
  }

  // ===================== Rendering =====================

  private renderBackground(): void {
    if (!this.bgLayer || !this.map) return;
    this.bgLayer.destroyChildren();
    const { width, height } = this.map;
    this.bgLayer.add(new Konva.Rect({ x: 0, y: 0, width, height, fill: this.bgColor(), listening: false }));

    const grid = this.gridSize();
    if (grid > 0) {
      const color = this.map.background.gridColor ?? 'rgba(0,0,0,0.06)';
      for (let x = 0; x <= width; x += grid) {
        this.bgLayer.add(new Konva.Line({ points: [x, 0, x, height], stroke: color, strokeWidth: 1, listening: false }));
      }
      for (let y = 0; y <= height; y += grid) {
        this.bgLayer.add(new Konva.Line({ points: [0, y, width, y], stroke: color, strokeWidth: 1, listening: false }));
      }
    }
    // Border so the canvas edge is visible against the page.
    this.bgLayer.add(new Konva.Rect({ x: 0, y: 0, width, height, stroke: 'rgba(0,0,0,0.25)', strokeWidth: 2, listening: false }));
    this.bgLayer.batchDraw();
  }

  /** Full rebuild of the element layer from the model. Called on structural
   *  changes (load, add, delete, z-order, label) — not on every drag. */
  private renderElements(): void {
    if (!this.elementLayer) return;
    this.transformer?.nodes([]);
    this.elementLayer.destroyChildren();
    this.nodes.clear();

    const ordered = [...this.elements()].sort((a, b) => a.z - b.z);
    for (const element of ordered) {
      if (element.kind === 'image') this.addImageNode(element);
      else this.addPathNode(element);
    }
    this.elementLayer.batchDraw();
    this.reattachTransformer();
  }

  private addImageNode(element: ImageElement): void {
    const node = new Konva.Image({
      image: undefined as unknown as HTMLImageElement,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      offsetX: element.width / 2,
      offsetY: element.height / 2,
      rotation: element.rotation,
      draggable: true,
      name: element.id,
    });
    void this.loadImage(this.proxyUrl(element.imageUrl)).then(img => {
      node.image(img);
      node.getLayer()?.batchDraw();
    });

    node.on('click tap', () => this.zone.run(() => this.select(element.id)));
    node.on('dragmove', () => this.positionLabel(element.id));
    node.on('dragend', () => {
      this.updateElementModel(element.id, { x: node.x(), y: node.y() });
    });
    node.on('transform', () => this.positionLabel(element.id));
    node.on('transformend', () => {
      const w = Math.max(16, node.width() * node.scaleX());
      const h = Math.max(16, node.height() * node.scaleY());
      node.scaleX(1);
      node.scaleY(1);
      node.width(w);
      node.height(h);
      node.offsetX(w / 2);
      node.offsetY(h / 2);
      this.positionLabel(element.id);
      this.updateElementModel(element.id, { width: w, height: h, rotation: node.rotation() });
    });

    this.elementLayer!.add(node);
    const label = this.makeLabel(element);
    if (label) this.elementLayer!.add(label);
    this.nodes.set(element.id, { node, label });
    this.positionLabel(element.id);
  }

  private addPathNode(element: PathElement): void {
    const flat = element.points.flatMap(p => [p.x, p.y]);
    const line = new Konva.Line({
      points: flat,
      stroke: element.stroke,
      strokeWidth: element.strokeWidth,
      tension: element.tension ?? 0,
      lineCap: 'round',
      lineJoin: 'round',
      hitStrokeWidth: Math.max(16, element.strokeWidth + 12),
      draggable: true,
      name: element.id,
    });
    line.on('click tap', () => this.zone.run(() => this.select(element.id)));
    line.on('dragmove', () => this.positionLabel(element.id));
    line.on('dragend', () => {
      const dx = line.x();
      const dy = line.y();
      line.position({ x: 0, y: 0 });
      const moved = element.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
      line.points(moved.flatMap(p => [p.x, p.y]));
      this.updateElementModel(element.id, { points: moved });
      this.positionLabel(element.id);
    });

    this.elementLayer!.add(line);
    const label = this.makeLabel(element);
    if (label) this.elementLayer!.add(label);
    this.nodes.set(element.id, { node: line, label });
    this.positionLabel(element.id);
  }

  private makeLabel(element: MapElement): Konva.Text | undefined {
    if (!element.label || element.labelVisible === false) return undefined;
    return new Konva.Text({
      text: element.label,
      fontSize: 16,
      fontStyle: '600',
      fill: '#2b2b2b',
      stroke: '#ffffff',
      strokeWidth: 3,
      fillAfterStrokeEnabled: true,
      listening: false,
    });
  }

  private positionLabel(id: string): void {
    const entry = this.nodes.get(id);
    if (!entry?.label) return;
    const { node, label } = entry;
    label.offsetX(label.width() / 2);
    if (node instanceof Konva.Image) {
      label.position({ x: node.x(), y: node.y() + node.height() / 2 + 6 });
    } else if (node instanceof Konva.Line) {
      const pts = (node as Konva.Line).points();
      label.position({ x: node.x() + (pts[0] ?? 0), y: node.y() + (pts[1] ?? 0) - 22 });
    }
    label.getLayer()?.batchDraw();
  }

  private reattachTransformer(): void {
    const id = this.selectedId();
    const entry = id ? this.nodes.get(id) : undefined;
    // Only image elements get resize/rotate handles.
    if (entry && entry.node instanceof Konva.Image) {
      this.transformer?.nodes([entry.node]);
    } else {
      this.transformer?.nodes([]);
    }
    this.overlayLayer?.batchDraw();
  }

  // ===================== Selection & mutation =====================

  select(id: string | null): void {
    this.selectedId.set(id);
    this.zone.runOutsideAngular(() => this.reattachTransformer());
  }

  /** Geometry write-back: updates the model + autosave without a full redraw. */
  private updateElementModel(id: string, patch: Partial<ImageElement> & Partial<PathElement>): void {
    this.zone.run(() => {
      this.elements.update(els => els.map(e => (e.id === id ? ({ ...e, ...patch } as MapElement) : e)));
      this.markDirty();
    });
  }

  setLabel(id: string, label: string): void {
    this.elements.update(els => els.map(e => (e.id === id ? { ...e, label } : e)));
    this.markDirty();
    this.zone.runOutsideAngular(() => this.renderElements());
  }

  toggleLabelVisible(id: string, visible: boolean): void {
    this.elements.update(els => els.map(e => (e.id === id ? { ...e, labelVisible: visible } : e)));
    this.markDirty();
    this.zone.runOutsideAngular(() => this.renderElements());
  }

  bringForward(id: string): void {
    this.restack(id, +1);
  }

  sendBackward(id: string): void {
    this.restack(id, -1);
  }

  private restack(id: string, dir: number): void {
    const ordered = [...this.elements()].sort((a, b) => a.z - b.z);
    const idx = ordered.findIndex(e => e.id === id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= ordered.length) return;
    [ordered[idx], ordered[swap]] = [ordered[swap], ordered[idx]];
    ordered.forEach((e, i) => (e.z = i));
    this.elements.set(ordered);
    this.markDirty();
    this.zone.runOutsideAngular(() => this.renderElements());
  }

  deleteSelected(): void {
    const id = this.selectedId();
    if (!id) return;
    this.delete(id);
  }

  delete(id: string): void {
    this.elements.update(els => els.filter(e => e.id !== id));
    if (this.selectedId() === id) this.selectedId.set(null);
    this.markDirty();
    this.zone.runOutsideAngular(() => this.renderElements());
  }

  /** Nudge the selected element with the arrow keys (accessible movement). */
  nudgeSelected(dx: number, dy: number): void {
    const el = this.selectedElement();
    if (!el) return;
    if (el.kind === 'image') {
      this.elements.update(els => els.map(e => (e.id === el.id ? { ...e, x: (e as ImageElement).x + dx, y: (e as ImageElement).y + dy } : e)));
    } else {
      this.elements.update(els =>
        els.map(e =>
          e.id === el.id
            ? { ...e, points: (e as PathElement).points.map(p => ({ x: p.x + dx, y: p.y + dy })) }
            : e,
        ),
      );
    }
    this.markDirty();
    this.zone.runOutsideAngular(() => this.renderElements());
  }

  private nextZ(): number {
    return this.elements().reduce((max, e) => Math.max(max, e.z), -1) + 1;
  }

  // ===================== Path drawing =====================

  selectTool(typeId: string): void {
    if (this.mode() === typeId) {
      this.cancelPath();
      return;
    }
    this.select(null);
    this.mode.set(typeId);
    this.drawing.set(true);
    this.draftPoints = [];
    this.draftPreview = null;
    this.zone.runOutsideAngular(() => this.stage?.draggable(false));
  }

  private addDraftPoint(): void {
    const pos = this.pointerPos();
    if (!pos) return;
    this.draftPoints.push(pos);
    this.renderDraft();
  }

  finishPath(): void {
    const preset = this.registry.pathPreset(this.mode());
    if (preset && this.draftPoints.length >= 2) {
      const element = this.registry.createPathElement(uuidv4(), preset);
      element.points = this.draftPoints.slice();
      element.z = this.nextZ();
      this.zone.run(() => {
        this.elements.update(els => [...els, element]);
        this.markDirty();
      });
    }
    this.cancelPath();
    this.zone.runOutsideAngular(() => this.renderElements());
  }

  cancelPath(): void {
    this.mode.set('select');
    this.drawing.set(false);
    this.draftPoints = [];
    this.draftPreview = null;
    this.draftLine?.destroy();
    this.draftLine = undefined;
    this.zone.runOutsideAngular(() => {
      this.stage?.draggable(true);
      this.overlayLayer?.batchDraw();
    });
  }

  private renderDraft(): void {
    if (!this.overlayLayer) return;
    const preset = this.registry.pathPreset(this.mode());
    if (!preset) return;
    const pts = [...this.draftPoints];
    if (this.draftPreview) pts.push(this.draftPreview);
    const flat = pts.flatMap(p => [p.x, p.y]);
    if (!this.draftLine) {
      this.draftLine = new Konva.Line({
        stroke: preset.stroke,
        strokeWidth: preset.strokeWidth,
        tension: preset.tension,
        dash: [10, 6],
        lineCap: 'round',
        lineJoin: 'round',
        listening: false,
      });
      this.overlayLayer.add(this.draftLine);
    }
    this.draftLine.points(flat);
    this.overlayLayer.batchDraw();
  }

  // ===================== Asset palette =====================

  private loadAssets(seriesId: string): void {
    this.assetService.getBySeries(seriesId).subscribe(assets => this.assets.set(assets));
  }

  onAssetDragStart(ev: DragEvent, asset: MapAsset): void {
    ev.dataTransfer?.setData('text/plain', asset.id);
  }

  private onDrop(ev: DragEvent): void {
    ev.preventDefault();
    const assetId = ev.dataTransfer?.getData('text/plain');
    const asset = this.assets().find(a => a.id === assetId);
    if (!asset || !this.stage) return;
    this.stage.setPointersPositions(ev);
    const pos = this.stage.getRelativePointerPosition();
    if (!pos) return;
    const element = this.registry.createImageElement(uuidv4(), asset.id, asset.imageUrl, pos.x, pos.y, asset.name);
    element.z = this.nextZ();
    this.zone.run(() => {
      this.elements.update(els => [...els, element]);
      this.markDirty();
      this.select(element.id);
    });
    this.zone.runOutsideAngular(() => this.renderElements());
  }

  deleteAsset(id: string): void {
    this.assetService.delete(id).subscribe({
      next: () => this.assets.update(list => list.filter(a => a.id !== id)),
    });
  }

  onUploadFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !this.map) return;
    const name = file.name.replace(/\.[^.]+$/, '');
    this.uploading.set(true);
    this.assetService.upload(this.map.seriesId, file, name).subscribe({
      next: asset => {
        this.assets.update(list => [...list, asset]);
        this.uploading.set(false);
        input.value = '';
      },
      error: () => {
        this.uploading.set(false);
        input.value = '';
      },
    });
  }

  // ===================== Background controls =====================

  onBgColor(color: string): void {
    this.bgColor.set(color);
    if (this.map) this.map.background.color = color;
    this.markDirty();
    this.zone.runOutsideAngular(() => this.renderBackground());
  }

  onGridSize(size: number): void {
    const n = Math.max(0, Math.round(size));
    this.gridSize.set(n);
    if (this.map) this.map.background.gridSize = n;
    this.markDirty();
    this.zone.runOutsideAngular(() => this.renderBackground());
  }

  onTitle(title: string): void {
    this.title.set(title);
    this.markDirty();
  }

  // ===================== View transforms =====================

  private onWheel(e: Konva.KonvaEventObject<WheelEvent>): void {
    e.evt.preventDefault();
    if (!this.stage) return;
    const scaleBy = 1.08;
    const old = this.stage.scaleX();
    const pointer = this.stage.getPointerPosition();
    if (!pointer) return;
    const mousePoint = { x: (pointer.x - this.stage.x()) / old, y: (pointer.y - this.stage.y()) / old };
    const next = e.evt.deltaY > 0 ? old / scaleBy : old * scaleBy;
    const clamped = Math.min(4, Math.max(0.1, next));
    this.stage.scale({ x: clamped, y: clamped });
    this.stage.position({ x: pointer.x - mousePoint.x * clamped, y: pointer.y - mousePoint.y * clamped });
    this.stage.batchDraw();
  }

  /** Fits the whole map into the viewport on first render. */
  private fitView(): void {
    if (!this.stage || !this.map) return;
    const sw = this.stage.width();
    const sh = this.stage.height();
    if (!sw || !sh) return;
    const scale = Math.min(sw / this.map.width, sh / this.map.height) * 0.95;
    this.stage.scale({ x: scale, y: scale });
    this.stage.position({ x: (sw - this.map.width * scale) / 2, y: (sh - this.map.height * scale) / 2 });
    this.stage.batchDraw();
  }

  resetView(): void {
    this.zone.runOutsideAngular(() => this.fitView());
  }

  private pointerPos(): { x: number; y: number } | null {
    return this.stage?.getRelativePointerPosition() ?? null;
  }

  private loadImage(url: string): Promise<HTMLImageElement> {
    const cached = this.imageCache.get(url);
    if (cached?.complete) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.imageCache.set(url, img);
        resolve(img);
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  // ===================== Persistence =====================

  private markDirty(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveStatus.set('saving');
    this.saveTimer = setTimeout(() => this.save(), 800);
  }

  private save(): void {
    if (!this.map || this.destroyed) return;
    const updated: SeriesMap = {
      ...this.map,
      title: this.title().trim() || 'Untitled Map',
      elements: this.elements(),
      background: {
        ...this.map.background,
        kind: 'color',
        color: this.bgColor(),
        gridSize: this.gridSize(),
      },
    };
    this.mapService.update(updated).subscribe({
      next: saved => {
        this.map = saved;
        this.saveStatus.set('saved');
      },
      error: () => this.saveStatus.set('error'),
    });
  }

  // ===================== Keyboard =====================

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.mode() !== 'select') {
      this.zone.run(() => this.cancelPath());
      return;
    }
    // Don't hijack typing in inputs.
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!this.selectedId()) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.zone.run(() => this.deleteSelected());
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.zone.run(() => this.nudgeSelected(0, -step));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.zone.run(() => this.nudgeSelected(0, step));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.zone.run(() => this.nudgeSelected(-step, 0));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.zone.run(() => this.nudgeSelected(step, 0));
    }
  };

  back(): void {
    const seriesId = this.map?.seriesId;
    this.router.navigate(seriesId ? ['/series', seriesId, 'maps'] : ['/maps']);
  }

  proxyUrl(url: string): string {
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : url;
  }
}
