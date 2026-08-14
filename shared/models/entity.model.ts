import { AuditedRecord } from './audited-record';

export type EntityReference = 'full-name' | 'first-name' | 'last-name' | 'nickname' | 'title-full-name' | 'title-last-name' | 'other';

export interface EntityRealWorldLocation {
  lat: number;
  lng: number;
  address?: string;
}

export interface EntityFictionalLocation {
  mapId: string;
  x: number;
  y: number;
}

export interface EntityLocation {
  type: 'real-world' | 'fictional';
  realWorld?: EntityRealWorldLocation;
  fictional?: EntityFictionalLocation;
}

/** Video containers accepted by the gallery uploader. */
export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'];

/**
 * Videos live in the same `photos` array as images — the blob extension is the
 * discriminator, so existing records need no migration. Blob names are
 * `<uuid><ext>`, so the extension always survives into the stored URL.
 */
export function isVideoUrl(url: string | undefined | null): boolean {
    if (!url) return false;
    const path = url.split('?')[0].split('#')[0].toLowerCase();
    return VIDEO_EXTENSIONS.some(ext => path.endsWith(ext));
}

export interface EntityPhoto {
    url: string;
    /** For videos this is the same blob as `url` — sharp can't produce a poster frame. */
    thumbnailUrl: string;
    caption?: string;
    hidden?: boolean;
}

export interface Entity extends AuditedRecord {
    id: string;
    name: string;
    type: 'PERSON' | 'PLACE' | 'THING';
    seriesId: string;
    sortOrder?: number;
    thumbnailUrl?: string;
    originalUrl?: string;
    biography?: string;
    title?: string;
    firstName?: string;
    lastName?: string;
    nickname?: string;
    aliases?: string[];
    preferredReference?: EntityReference;
    personality?: string;
    gender?: string;
    race?: string;
    orientation?: string;
    archived?: boolean;
    deleted?: boolean;
    isNarrator?: boolean;
    photos?: EntityPhoto[];
    location?: EntityLocation;
}