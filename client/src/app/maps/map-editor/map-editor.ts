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
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import Konva from 'konva';
import { v4 as uuidv4 } from 'uuid';
import { SeriesMap, MapElement, ImageElement, PathElement } from '@shared/models/map.model';
import { MapAsset } from '@shared/models/map-asset.model';
import { Entity } from '@shared/models/entity.model';
import { MapService } from '../map.service';
import { MapAssetService } from '../map-asset.service';
import { MapElementRegistry } from '../map-element.registry';
import { EntityService } from '../../services/entity.service';
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
    MatSelectModule,
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
  private http = inject(HttpClient);
  private mapService = inject(MapService);
  private assetService = inject(MapAssetService);
  private registry = inject(MapElementRegistry);
  private entityService = inject(EntityService);
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
  readonly bgImageUrl = signal<string | null>(null);
  readonly uploadingBg = signal(false);
  readonly placeEntities = signal<Entity[]>([]);
  readonly placeFilter = signal('');
  readonly filteredPlaces = computed(() => {
    const q = this.placeFilter().toLowerCase().trim();
    if (!q) return this.placeEntities();
    return this.placeEntities().filter(p => p.name.toLowerCase().includes(q));
  });

  readonly pathPresets = this.registry.pathPresets;

  // ----- Panel resize state -----
  private static readPanelWidth(key: string, fallback: number): number {
    const v = parseInt(localStorage.getItem(key) ?? '', 10);
    return isNaN(v) ? fallback : Math.max(56, Math.min(520, v));
  }

  readonly paletteWidth = signal(MapEditorComponent.readPanelWidth('map-palette-width', 240));
  readonly propsWidth   = signal(MapEditorComponent.readPanelWidth('map-props-width',   240));

  startResize(e: MouseEvent, panel: 'palette' | 'props'): void {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panel === 'palette' ? this.paletteWidth() : this.propsWidth();
    const storageKey = panel === 'palette' ? 'map-palette-width' : 'map-props-width';

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const next = Math.max(56, Math.min(520,
        panel === 'palette' ? startWidth + delta : startWidth - delta
      ));
      this.zone.run(() => {
        if (panel === 'palette') this.paletteWidth.set(next);
        else this.propsWidth.set(next);
      });
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing-col');
      localStorage.setItem(storageKey, String(
        panel === 'palette' ? this.paletteWidth() : this.propsWidth()
      ));
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.classList.add('resizing-col');
  }

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
  private lastThumbnailMs = 0;
  private readonly THUMBNAIL_INTERVAL_MS = 30_000;

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
          this.bgImageUrl.set(map.background.imageUrl ?? null);
          this.loading.set(false);
          this.seriesContext.set(map.seriesId);
          this.headerService.set([
            { label: 'Maps', link: '/series/' + map.seriesId + '/maps' },
            { label: map.title },
          ]);
          this.loadAssets(map.seriesId);
          this.loadPlaces(map.seriesId);
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

    // Base fill (always drawn so the canvas has a colour even while the image loads).
    this.bgLayer.add(new Konva.Rect({ x: 0, y: 0, width, height, fill: this.bgColor(), listening: false }));

    const imageUrl = this.bgImageUrl();
    if (imageUrl) {
      void this.loadImage(this.proxyUrl(imageUrl)).then(img => {
        if (!this.bgLayer || !this.map) return;
        const bgImage = new Konva.Image({
          image: img,
          x: 0, y: 0,
          width, height,
          listening: false,
        });
        // Insert behind grid lines (index 1, after the colour rect).
        this.bgLayer.add(bgImage);
        bgImage.zIndex(1);
        this.bgLayer.batchDraw();
      });
    }

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
    const preset = this.registry.pathPreset(element.typeId);
    if (preset?.varyWidth && element.points.length >= 2) {
      this.addVariableWidthPathNode(element);
      return;
    }

    const flat = element.points.flatMap(p => [p.x, p.y]);
    const line = new Konva.Line({
      points: flat,
      stroke: element.stroke,
      strokeWidth: element.strokeWidth,
      tension: element.tension ?? 0,
      ...(element.dash ? { dash: element.dash } : {}),
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

  /**
   * Renders a river as a filled polygon whose width varies organically at each
   * point. Each side of the river is a smooth quadratic-bezier curve drawn
   * through perpendicular offset points; the widths are determined by a stable
   * deterministic function of the point coordinates so the shape never changes
   * on re-render.
   */
  private addVariableWidthPathNode(element: PathElement): void {
    const pts = element.points;
    const baseHalf = element.strokeWidth / 2;

    // Stable pseudo-random half-width per point, range 0.35×–1.65× base.
    const halfWidths = pts.map((p, i) =>
      baseHalf * (0.35 + (Math.sin(i * 2.399 + p.x * 0.017 + p.y * 0.023) * 0.5 + 0.5) * 1.3),
    );

    // Perpendicular unit normal at each point (averaged over neighbouring segments).
    const normals = pts.map((_, i) => {
      const prev = pts[i - 1] ?? pts[i];
      const next = pts[i + 1] ?? pts[i];
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      return { nx: -dy / len, ny: dx / len };
    });

    const left  = pts.map((p, i) => ({ x: p.x + normals[i].nx * halfWidths[i], y: p.y + normals[i].ny * halfWidths[i] }));
    const right = pts.map((p, i) => ({ x: p.x - normals[i].nx * halfWidths[i], y: p.y - normals[i].ny * halfWidths[i] }));

    /** Draw a smooth open curve through a set of points using quadratic beziers. */
    const curveThroughPoints = (ctx: CanvasRenderingContext2D, curve: { x: number; y: number }[]) => {
      ctx.moveTo(curve[0].x, curve[0].y);
      for (let i = 0; i < curve.length - 1; i++) {
        const mx = (curve[i].x + curve[i + 1].x) / 2;
        const my = (curve[i].y + curve[i + 1].y) / 2;
        ctx.quadraticCurveTo(curve[i].x, curve[i].y, mx, my);
      }
      ctx.lineTo(curve[curve.length - 1].x, curve[curve.length - 1].y);
    };

    const shape = new Konva.Shape({
      sceneFunc: (ctx) => {
        const raw = ctx as unknown as CanvasRenderingContext2D;
        raw.beginPath();
        curveThroughPoints(raw, left);
        // Continue backward along the right side to close the polygon.
        const rightReversed = [...right].reverse();
        for (let i = 0; i < rightReversed.length - 1; i++) {
          const mx = (rightReversed[i].x + rightReversed[i + 1].x) / 2;
          const my = (rightReversed[i].y + rightReversed[i + 1].y) / 2;
          raw.quadraticCurveTo(rightReversed[i].x, rightReversed[i].y, mx, my);
        }
        raw.lineTo(right[0].x, right[0].y);
        raw.closePath();
        raw.fillStyle = element.stroke;
        raw.fill();
      },
      hitFunc: (ctx) => {
        // Hit region: a generous rect around the bounding box of all points.
        const xs = pts.map(p => p.x);
        const ys = pts.map(p => p.y);
        const pad = element.strokeWidth * 2;
        const x = Math.min(...xs) - pad;
        const y = Math.min(...ys) - pad;
        const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
        const h = Math.max(...ys) - Math.min(...ys) + pad * 2;
        (ctx as unknown as CanvasRenderingContext2D).beginPath();
        (ctx as unknown as CanvasRenderingContext2D).rect(x, y, w, h);
        (ctx as unknown as CanvasRenderingContext2D).fill();
      },
      draggable: true,
      name: element.id,
    });

    shape.on('click tap', () => this.zone.run(() => this.select(element.id)));
    shape.on('dragmove', () => this.positionLabel(element.id));
    shape.on('dragend', () => {
      const dx = shape.x();
      const dy = shape.y();
      shape.position({ x: 0, y: 0 });
      const moved = element.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
      this.updateElementModel(element.id, { points: moved });
      this.positionLabel(element.id);
      // Re-render so the offset polygons reflect the new coords.
      this.renderElements();
    });

    this.elementLayer!.add(shape);
    const label = this.makeLabel(element);
    if (label) this.elementLayer!.add(label);
    this.nodes.set(element.id, { node: shape, label });
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
        dash: preset.dash ?? [10, 6],
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

  private loadPlaces(seriesId: string): void {
    this.entityService.getBySeries(seriesId).subscribe(entities =>
      this.placeEntities.set(entities.filter(e => e.type === 'PLACE').sort((a, b) => a.name.localeCompare(b.name)))
    );
  }

  linkEntity(elementId: string, entityId: string | null): void {
    this.elements.update(els => els.map(el =>
      el.id === elementId && el.kind === 'image'
        ? { ...el, entityId: entityId ?? undefined }
        : el
    ));
    this.markDirty();
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

  onBgImageFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !this.map) return;
    this.uploadingBg.set(true);
    const formData = new FormData();
    formData.append('file', file);
    this.http.post<{ url: string; thumbnailUrl: string }>('/api/upload', formData).subscribe({
      next: ({ url }) => {
        this.bgImageUrl.set(url);
        if (this.map) this.map.background.imageUrl = url;
        this.uploadingBg.set(false);
        this.markDirty();
        this.zone.runOutsideAngular(() => this.renderBackground());
        input.value = '';
      },
      error: () => {
        this.uploadingBg.set(false);
        input.value = '';
      },
    });
  }

  clearBgImage(): void {
    this.bgImageUrl.set(null);
    if (this.map) this.map.background.imageUrl = undefined;
    this.markDirty();
    this.zone.runOutsideAngular(() => this.renderBackground());
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
        kind: this.bgImageUrl() ? 'image' : 'color',
        color: this.bgColor(),
        gridSize: this.gridSize(),
        imageUrl: this.bgImageUrl() ?? undefined,
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

  readonly savingPreview = signal(false);

  /** Deselects everything, captures a clean snapshot, uploads it as the map thumbnail. */
  savePreview(): void {
    if (this.savingPreview()) return;
    this.savingPreview.set(true);

    this.zone.runOutsideAngular(() => {
      // Hide selection handles and overlay for a clean capture.
      this.transformer?.hide();
      this.overlayLayer?.hide();
      this.elementLayer?.batchDraw();

      const dataUrl = this.captureSnapshot(0.8);

      this.transformer?.show();
      this.overlayLayer?.show();
      this.elementLayer?.batchDraw();

      if (!dataUrl) {
        this.zone.run(() => this.savingPreview.set(false));
        return;
      }

      const blob = this.dataUrlToBlob(dataUrl);
      const file = new File([blob], 'map-snapshot.png', { type: 'image/png' });
      const formData = new FormData();
      formData.append('file', file);
      this.zone.run(() => {
        this.http.post<{ url: string; thumbnailUrl: string }>('/api/upload?thumbSize=1600', formData).subscribe({
          next: ({ thumbnailUrl }) => {
            if (!this.map) return;
            const withThumb: SeriesMap = { ...this.map, thumbnailUrl };
            this.mapService.update(withThumb).subscribe({
              next: saved => { this.map = saved; this.savingPreview.set(false); },
              error: () => this.savingPreview.set(false),
            });
          },
          error: () => this.savingPreview.set(false),
        });
      });
    });
  }

  /** Renders the full logical map to a data URL at the given pixel ratio,
   *  temporarily overriding the stage's current pan/zoom. */
  private captureSnapshot(pixelRatio: number): string | null {
    if (!this.stage || !this.map) return null;
    const { width, height } = this.map;
    const prevScale = this.stage.scaleX();
    const prevPos = this.stage.position();
    const prevW = this.stage.width();
    const prevH = this.stage.height();
    try {
      this.stage.scale({ x: 1, y: 1 });
      this.stage.position({ x: 0, y: 0 });
      this.stage.width(width);
      this.stage.height(height);
      return this.stage.toDataURL({ pixelRatio });
    } catch {
      return null;
    } finally {
      this.stage.width(prevW);
      this.stage.height(prevH);
      this.stage.scale({ x: prevScale, y: prevScale });
      this.stage.position(prevPos);
      this.stage.batchDraw();
    }
  }

  private dataUrlToBlob(dataUrl: string): Blob {
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)![1];
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
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
