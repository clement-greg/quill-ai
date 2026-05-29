import { AuditedRecord } from './audited-record';

export type EntityReference = 'full-name' | 'first-name' | 'last-name' | 'nickname' | 'title-full-name' | 'title-last-name';

export interface EntityPhoto {
    url: string;
    thumbnailUrl: string;
    caption?: string;
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
}