import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { ChapterNote, OutlineItem } from '@shared/models/chapter.model';

export interface ChapterExternalUpdate {
  id: string;
  outline?: OutlineItem[];
  notes?: ChapterNote[];
}

@Injectable({ providedIn: 'root' })
export class ChapterSyncService {
  private readonly updates = new Subject<ChapterExternalUpdate>();
  readonly updates$ = this.updates.asObservable();

  notify(update: ChapterExternalUpdate): void {
    this.updates.next(update);
  }
}
