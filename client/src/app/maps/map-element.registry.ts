import { Injectable } from '@angular/core';
import { ImageElement, PathElement } from '@shared/models/map.model';

/**
 * A drawable line preset (river, road, border, …). Selecting one puts the
 * editor into draw mode; clicking the canvas adds points to a new PathElement
 * seeded from these defaults.
 */
export interface PathPreset {
  typeId: string;
  name: string;
  /** Material Symbol name for the palette button. */
  icon: string;
  stroke: string;
  strokeWidth: number;
  /** Konva line tension; > 0 produces a smooth curve. */
  tension: number;
  /**
   * When true the renderer draws a filled polygon with organically varying
   * widths instead of a uniform stroke, simulating a natural river.
   */
  varyWidth?: boolean;
  /** Konva dash pattern [dash, gap, …]; omit for a solid stroke. */
  dash?: number[];
}

/**
 * Single source of truth for the built-in element *kinds* and their defaults.
 *
 * Extensibility model:
 *  - New visual stamps are data (a MapAsset upload) and reuse the 'image' kind
 *    with their own typeId — no code change.
 *  - New line styles are a one-line entry in PATH_PRESETS below.
 *  - A genuinely new behavioral kind (e.g. polygon regions) is additive: add a
 *    variant to the MapElement union and a render branch in the editor.
 */
@Injectable({ providedIn: 'root' })
export class MapElementRegistry {
  /** Default footprint (logical px) for a freshly-dropped image stamp. */
  readonly defaultImageSize = 96;

  readonly pathPresets: readonly PathPreset[] = [
    { typeId: 'river', name: 'River', icon: 'water', stroke: '#3a7bd5', strokeWidth: 6, tension: 0.5, varyWidth: true },
    { typeId: 'road', name: 'Road', icon: 'route', stroke: '#8d6e4f', strokeWidth: 5, tension: 0 },
    { typeId: 'border', name: 'Border', icon: 'gesture', stroke: '#9c27b0', strokeWidth: 3, tension: 0 },
    { typeId: 'path', name: 'Path', icon: 'footprint', stroke: '#6d4c2f', strokeWidth: 7, tension: 0.5, dash: [14, 10] },
  ];

  pathPreset(typeId: string): PathPreset | undefined {
    return this.pathPresets.find(p => p.typeId === typeId);
  }

  /** Builds a new image element centered at the given logical coordinates. */
  createImageElement(id: string, typeId: string, imageUrl: string, x: number, y: number, label?: string): ImageElement {
    return {
      id,
      kind: 'image',
      typeId,
      x,
      y,
      width: this.defaultImageSize,
      height: this.defaultImageSize,
      rotation: 0,
      imageUrl,
      ...(label ? { label } : {}),
      labelVisible: true,
      z: 0,
    };
  }

  /** Builds a new, empty path element from a preset. */
  createPathElement(id: string, preset: PathPreset): PathElement {
    return {
      id,
      kind: 'path',
      typeId: preset.typeId,
      points: [],
      stroke: preset.stroke,
      strokeWidth: preset.strokeWidth,
      tension: preset.tension,
      ...(preset.dash ? { dash: preset.dash } : {}),
      labelVisible: true,
      z: 0,
    };
  }
}
