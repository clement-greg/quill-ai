import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ChapterVersion } from '@shared/models/chapter.model';

@Injectable({ providedIn: 'root' })
export class ChapterVersionService {
  private http = inject(HttpClient);

  getByChapter(chapterId: string): Observable<ChapterVersion[]> {
    return this.http.get<ChapterVersion[]>(`/api/chapter-versions/chapter/${encodeURIComponent(chapterId)}`);
  }

  create(chapterId: string, content: string, createdByName?: string): Observable<ChapterVersion> {
    return this.http.post<ChapterVersion>('/api/chapter-versions', { chapterId, content, createdByName });
  }
}
