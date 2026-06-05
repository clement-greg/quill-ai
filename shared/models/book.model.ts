import { AuditedRecord } from './audited-record';
import { OutlineItem } from './chapter.model';

export interface Book extends AuditedRecord {
    title: string;
    id: string;
    seriesId: string;
    thumnailUrl?: string;
    originalUrl?: string;
    sortOrder?: number;
    archived?: boolean;
    deleted?: boolean;
    notes?: string;
    outline?: OutlineItem[];
}