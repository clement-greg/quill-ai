import { AuditedRecord } from './audited-record';

/**
 * A reusable image stamp in a series' palette. Users upload these; each one
 * becomes a draggable item in the map editor and can be placed on any map in
 * the series. This is the user-facing extensibility mechanism — a "new element
 * type" is just a new asset, no code change required.
 */
export interface MapAsset extends AuditedRecord {
  id: string;
  seriesId: string;
  name: string;
  /** Optional palette grouping, e.g. 'Terrain', 'Buildings'. */
  category?: string;
  imageUrl: string;
  thumbnailUrl: string;
}
