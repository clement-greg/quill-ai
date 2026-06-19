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

export interface EntityPhoto {
    url: string;
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