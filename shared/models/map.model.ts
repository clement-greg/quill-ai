import { AuditedRecord } from './audited-record';

/**
 * The drawable surface behind a map's elements. v1 only renders the 'color'
 * kind (with an optional grid overlay); the 'image' kind is reserved so a
 * user-uploaded background can be added later without a data migration.
 */
export interface MapBackground {
  kind: 'color' | 'image';
  color: string;
  /** Grid spacing in logical px. Undefined or 0 hides the grid. */
  gridSize?: number;
  gridColor?: string;
  /** Reserved for the future 'image' background kind. */
  imageUrl?: string;
}

/** Fields shared by every map element regardless of kind. */
interface BaseElement {
  id: string;
  /**
   * Registry type identifier (e.g. 'mountain', 'river'). New visual stamps
   * reuse the 'image' kind with their own typeId, so adding element types
   * after the fact is data, not code. See MapElementRegistry on the client.
   */
  typeId: string;
  label?: string;
  labelVisible?: boolean;
  /** Draw order; higher renders on top. */
  z: number;
}

/** An image stamp (mountain, building, lake, …) placed on the surface. */
export interface ImageElement extends BaseElement {
  kind: 'image';
  /** Center position in logical coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation in degrees, clockwise. */
  rotation: number;
  imageUrl: string;
  /** Optional link to a Place entity in the same series. */
  entityId?: string;
}

/** A multi-point line for rivers, roads, borders, etc. */
export interface PathElement extends BaseElement {
  kind: 'path';
  points: { x: number; y: number }[];
  stroke: string;
  strokeWidth: number;
  /** Konva line tension; > 0 renders a smooth curve (rivers). */
  tension?: number;
  /** Konva dash pattern [dash, gap, …]; omit for a solid stroke (paths). */
  dash?: number[];
}

/**
 * A closed, filled area (kingdom, forest, sea, …). Drawn as a smooth closed
 * curve through its points; the interior is mostly transparent while the
 * border is mostly opaque, so regions read as washes over the map.
 */
export interface RegionElement extends BaseElement {
  kind: 'region';
  points: { x: number; y: number }[];
  /** Interior + border colour (hex). */
  fill: string;
  /** Interior opacity 0–1 (regions are mostly transparent inside). */
  fillOpacity: number;
  /** Border colour (hex); usually matches `fill`. */
  stroke: string;
  /** Border opacity 0–1 (regions have a mostly-opaque border). */
  strokeOpacity: number;
  strokeWidth: number;
  /** Konva line tension; > 0 smooths the outline into bezier curves. */
  tension?: number;
}

/**
 * Discriminated union of element kinds. Adding a new behavioral kind later
 * is additive: extend this union and add a render branch in the editor —
 * existing maps are unaffected.
 */
export type MapElement = ImageElement | PathElement | RegionElement;

/** A user-built map of an imaginary world, owned by a series. */
export interface SeriesMap extends AuditedRecord {
  id: string;
  seriesId: string;
  title: string;
  description?: string;
  /** Logical canvas dimensions; element coordinates are relative to these. */
  width: number;
  height: number;
  background: MapBackground;
  elements: MapElement[];
  /** Auto-generated snapshot URL (400px thumbnail via the shared /api/upload pipeline). */
  thumbnailUrl?: string;
  archived?: boolean;
}
