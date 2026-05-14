import { Component, inject, signal, computed, OnInit, OnDestroy, ElementRef, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatDialog } from '@angular/material/dialog';
import { forkJoin, Subscription } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { Entity } from '@shared/models/entity.model';
import { EntityRelationship, DiagramLayout, DiagramNodePosition, RELATIONSHIP_TYPES } from '@shared/models/entity-relationship.model';
import { Series } from '@shared/models/series.model';
import { EntityService } from '../services/entity.service';
import { EntityRelationshipService } from '../services/entity-relationship.service';
import { HeaderService } from '../services/header.service';
import { SeriesService } from '../series/series.service';
import { RelationshipDialogComponent, RelationshipDialogResult } from './relationship-dialog';

interface ConnectionLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
}

const NODE_WIDTH = 120;
const NODE_HEIGHT = 100;

@Component({
  selector: 'app-entity-relationship-diagram',
  imports: [FormsModule, MatButtonModule, MatIconModule, MatSelectModule],
  templateUrl: './entity-relationship-diagram.html',
  styleUrl: './entity-relationship-diagram.scss',
})
export class EntityRelationshipDiagramComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private entityService = inject(EntityService);
  private relationshipService = inject(EntityRelationshipService);
  private headerService = inject(HeaderService);
  private seriesService = inject(SeriesService);
  private dialog = inject(MatDialog);

  canvas = viewChild<ElementRef<HTMLDivElement>>('canvas');

  allSeries = signal<Series[]>([]);
  currentSeriesId = signal<string | null>(null);
  private allEntities = signal<Entity[]>([]);
  private relationships = signal<EntityRelationship[]>([]);
  private layout = signal<DiagramLayout | null>(null);
  private routeSub?: Subscription;

  diagramNodes = signal<DiagramNodePosition[]>([]);
  selectedNodeId = signal<string | null>(null);
  selectedRelationshipId = signal<string | null>(null);
  connectingFrom = signal<DiagramNodePosition | null>(null);
  tempLineEnd = signal<{ x: number; y: number } | null>(null);

  // Entities NOT yet on the canvas
  availableEntities = computed(() => {
    const onCanvas = new Set(this.diagramNodes().map((n) => n.entityId));
    return this.allEntities().filter((e) => !onCanvas.has(e.id));
  });

  // SVG connection lines
  connectionLines = computed<ConnectionLine[]>(() => {
    const nodes = this.diagramNodes();
    const rels = this.relationships();
    const nodeMap = new Map(nodes.map((n) => [n.entityId, n]));

    return rels
      .filter((r) => nodeMap.has(r.sourceEntityId) && nodeMap.has(r.targetEntityId))
      .map((r) => {
        const src = nodeMap.get(r.sourceEntityId)!;
        const tgt = nodeMap.get(r.targetEntityId)!;
        const typeLabel = RELATIONSHIP_TYPES.find((t) => t.value === r.relationshipType)?.label ?? r.relationshipType;
        return {
          id: r.id,
          x1: src.x + NODE_WIDTH / 2,
          y1: src.y + NODE_HEIGHT / 2,
          x2: tgt.x + NODE_WIDTH / 2,
          y2: tgt.y + NODE_HEIGHT / 2,
          label: typeLabel,
        };
      });
  });

  // ── drag state (node dragging) ──
  private draggingNode: DiagramNodePosition | null = null;
  private dragOffset = { x: 0, y: 0 };
  private boundOnMouseMove = this.onMouseMove.bind(this);
  private boundOnMouseUp = this.onMouseUp.bind(this);

  ngOnInit(): void {
    this.seriesService.getAll().subscribe({
      next: (data) => {
        this.allSeries.set(
          data.filter((s: any) => !s.deleted && !s.archived)
               .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''))
        );
      },
    });

    this.routeSub = this.route.paramMap.subscribe(params => {
      const id = params.get('seriesId');
      this.currentSeriesId.set(id);
      this.allEntities.set([]);
      this.relationships.set([]);
      this.diagramNodes.set([]);
      this.layout.set(null);
      if (id) {
        this.loadData(id);
        this.seriesService.getById(id).subscribe({
          next: (series) => {
            this.headerService.set(
              [{ label: series.title, link: '/series/' + series.id }, { label: 'Relationships' }]
            );
          },
        });
      } else {
        this.headerService.set([{ label: 'Relationships' }]);
      }
    });

    document.addEventListener('mousemove', this.boundOnMouseMove);
    document.addEventListener('mouseup', this.boundOnMouseUp);
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.headerService.clear();
    document.removeEventListener('mousemove', this.boundOnMouseMove);
    document.removeEventListener('mouseup', this.boundOnMouseUp);
  }

  selectSeries(id: string): void {
    this.router.navigate(['/series', id, 'relationships']);
  }

  private loadData(seriesId: string): void {
    forkJoin({
      entities: this.entityService.getBySeries(seriesId),
      relationships: this.relationshipService.getBySeries(seriesId),
      layout: this.relationshipService.getLayout(seriesId),
    }).subscribe(({ entities, relationships, layout }) => {
      this.allEntities.set(entities);
      this.relationships.set(relationships);
      if (layout) {
        this.layout.set(layout);
        this.diagramNodes.set(layout.positions ?? []);
      }
    });
  }

  // ── Palette drag & drop ──

  onPaletteDragStart(event: DragEvent, entity: Entity): void {
    event.dataTransfer?.setData('entityId', entity.id);
  }

  onCanvasDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  onCanvasDrop(event: DragEvent): void {
    event.preventDefault();
    const entityId = event.dataTransfer?.getData('entityId');
    if (!entityId) return;

    const canvasEl = this.canvas()?.nativeElement;
    if (!canvasEl) return;

    const rect = canvasEl.getBoundingClientRect();
    const x = event.clientX - rect.left + canvasEl.scrollLeft - NODE_WIDTH / 2;
    const y = event.clientY - rect.top + canvasEl.scrollTop - NODE_HEIGHT / 2;

    const node: DiagramNodePosition = { entityId, x: Math.max(0, x), y: Math.max(0, y) };
    this.diagramNodes.update((nodes) => [...nodes, node]);
    this.saveLayout();
  }

  // ── Node interactions ──

  onNodeMouseDown(event: MouseEvent, node: DiagramNodePosition): void {
    if (this.connectingFrom()) return; // don't drag while connecting
    event.stopPropagation();
    this.draggingNode = node;
    this.dragOffset = { x: event.clientX - node.x, y: event.clientY - node.y };
  }

  private onMouseMove(event: MouseEvent): void {
    if (this.draggingNode) {
      const x = Math.max(0, event.clientX - this.dragOffset.x);
      const y = Math.max(0, event.clientY - this.dragOffset.y);
      this.diagramNodes.update((nodes) =>
        nodes.map((n) => (n.entityId === this.draggingNode!.entityId ? { ...n, x, y } : n))
      );
    }
    if (this.connectingFrom()) {
      const canvasEl = this.canvas()?.nativeElement;
      if (!canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      this.tempLineEnd.set({
        x: event.clientX - rect.left + canvasEl.scrollLeft,
        y: event.clientY - rect.top + canvasEl.scrollTop,
      });
    }
  }

  private onMouseUp(_event: MouseEvent): void {
    if (this.draggingNode) {
      this.draggingNode = null;
      this.saveLayout();
    }
  }

  onNodeClick(event: MouseEvent, node: DiagramNodePosition): void {
    event.stopPropagation();

    if (this.connectingFrom()) {
      if (this.connectingFrom()!.entityId === node.entityId) return;
      this.createRelationship(this.connectingFrom()!.entityId, node.entityId);
      this.connectingFrom.set(null);
      this.tempLineEnd.set(null);
      return;
    }

    this.selectedNodeId.set(node.entityId);
    this.selectedRelationshipId.set(null);
  }

  onCanvasClick(): void {
    this.selectedNodeId.set(null);
    this.selectedRelationshipId.set(null);
    if (this.connectingFrom()) {
      this.cancelConnecting();
    }
  }

  removeNodeFromCanvas(event: MouseEvent, entityId: string): void {
    event.stopPropagation();
    this.diagramNodes.update((nodes) => nodes.filter((n) => n.entityId !== entityId));
    if (this.selectedNodeId() === entityId) {
      this.selectedNodeId.set(null);
    }
    this.saveLayout();
  }

  // ── Connecting ──

  startConnecting(): void {
    const id = this.selectedNodeId();
    if (!id) return;
    const node = this.diagramNodes().find((n) => n.entityId === id);
    if (node) {
      this.connectingFrom.set(node);
    }
  }

  cancelConnecting(): void {
    this.connectingFrom.set(null);
    this.tempLineEnd.set(null);
  }

  private createRelationship(sourceId: string, targetId: string): void {
    const source = this.getEntity(sourceId);
    const target = this.getEntity(targetId);
    const seriesId = this.currentSeriesId();
    if (!source || !target || !seriesId) return;

    const dialogRef = this.dialog.open(RelationshipDialogComponent, {
      width: '440px',
      data: { source, target },
    });

    dialogRef.afterClosed().subscribe((result: RelationshipDialogResult | undefined) => {
      if (!result) return;

      const rel: EntityRelationship = {
        id: uuidv4(),
        seriesId: seriesId,
        sourceEntityId: sourceId,
        targetEntityId: targetId,
        relationshipType: result.relationshipType,
        description: result.description,
      };

      this.relationshipService.create(rel).subscribe({
        next: (created) => {
          this.relationships.update((list) => [...list, created]);
        },
      });
    });
  }

  // ── Connection interactions ──

  onConnectionClick(event: MouseEvent, relationshipId: string): void {
    event.stopPropagation();
    this.selectedRelationshipId.set(relationshipId);
    this.selectedNodeId.set(null);
  }

  editSelectedRelationship(): void {
    const relId = this.selectedRelationshipId();
    if (!relId) return;
    const rel = this.relationships().find((r) => r.id === relId);
    if (!rel) return;

    const source = this.getEntity(rel.sourceEntityId);
    const target = this.getEntity(rel.targetEntityId);
    if (!source || !target) return;

    const dialogRef = this.dialog.open(RelationshipDialogComponent, {
      width: '440px',
      data: { source, target, relationshipType: rel.relationshipType, description: rel.description },
    });

    dialogRef.afterClosed().subscribe((result: RelationshipDialogResult | undefined) => {
      if (!result) return;
      const updated: EntityRelationship = { ...rel, ...result };
      this.relationshipService.update(updated).subscribe({
        next: (saved) => {
          this.relationships.update((list) =>
            list.map((r) => (r.id === saved.id ? saved : r))
          );
        },
      });
    });
  }

  deleteSelectedRelationship(): void {
    const relId = this.selectedRelationshipId();
    if (!relId) return;
    this.relationshipService.delete(relId).subscribe({
      next: () => {
        this.relationships.update((list) => list.filter((r) => r.id !== relId));
        this.selectedRelationshipId.set(null);
      },
    });
  }

  // ── Helpers ──

  getEntity(id: string): Entity | undefined {
    return this.allEntities().find((e) => e.id === id);
  }

  getNodeCenter(entityId: string): { x: number; y: number } {
    const node = this.diagramNodes().find((n) => n.entityId === entityId);
    return node
      ? { x: node.x + NODE_WIDTH / 2, y: node.y + NODE_HEIGHT / 2 }
      : { x: 0, y: 0 };
  }

  proxyUrl(url: string | undefined): string | null {
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }

  private saveLayout(): void {
    const seriesId = this.currentSeriesId();
    if (!seriesId) return;
    const existing = this.layout();
    const layout: DiagramLayout = {
      id: existing?.id ?? uuidv4(),
      seriesId: seriesId,
      positions: this.diagramNodes(),
      createdBy: existing?.createdBy,
      createdAt: existing?.createdAt,
    };
    this.relationshipService.saveLayout(seriesId, layout).subscribe({
      next: (saved) => this.layout.set(saved),
    });
  }
}
