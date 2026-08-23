import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, defer, retry, throwError, timeout, timer } from 'rxjs';
import { Entity } from '@shared/models/entity.model';

/**
 * Backstop for a receiver request (video or images). The server waits up to 60s
 * on the receiver before answering, so this only fires when the request itself
 * is stuck.
 */
const GENERATION_REQUEST_TIMEOUT_MS = 75_000;

/** The queued ComfyUI job the receiver reports back for an image-to-video request. */
export interface VideoGenJob {
  promptId: string | null;
  seed: number | null;
  queueNumber: number | null;
  /** Frame count the duration was snapped to, or null when none was requested. */
  frames: number | null;
}

/** What a batch of receiver-generated stills is asked for; see PhotoGenResult. */
export interface PhotoGenRequest {
  prompt: string;
  count: number;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
}

/** The queued ComfyUI job the receiver reports back for an image batch. */
export interface PhotoGenJob {
  promptId: string | null;
  seed: number | null;
  queueNumber: number | null;
  /** Images the run was queued for. */
  count: number;
}

export interface ChapterAppearance {
  id: string;
  title: string;
  sortOrder?: number;
  bookId: string;
  bookTitle: string;
  imageUrl?: string;
  imageThumbnailUrl?: string;
}

@Injectable({ providedIn: 'root' })
export class EntityService {
  private http = inject(HttpClient);
  private readonly apiUrl = '/api/entities';

  getAll(): Observable<Entity[]> {
    return this.http.get<Entity[]>(this.apiUrl);
  }

  getBySeries(seriesId: string): Observable<Entity[]> {
    return this.http.get<Entity[]>(`${this.apiUrl}/series/${seriesId}`);
  }

  getArchivedBySeries(seriesId: string): Observable<Entity[]> {
    return this.http.get<Entity[]>(`${this.apiUrl}/series/${seriesId}/archived`);
  }

  getById(id: string): Observable<Entity> {
    return this.http.get<Entity>(`${this.apiUrl}/${id}`);
  }

  create(entity: Entity): Observable<Entity> {
    return this.http.post<Entity>(this.apiUrl, entity);
  }

  update(entity: Entity): Observable<Entity> {
    return this.http.put<Entity>(`${this.apiUrl}/${entity.id}`, entity);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }

  archive(id: string): Observable<Entity> {
    return this.http.patch<Entity>(`${this.apiUrl}/${id}/archive`, {});
  }

  unarchive(id: string): Observable<Entity> {
    return this.http.patch<Entity>(`${this.apiUrl}/${id}/unarchive`, {});
  }

  softDelete(id: string): Observable<Entity> {
    return this.http.patch<Entity>(`${this.apiUrl}/${id}/soft-delete`, {});
  }

  restoreDelete(id: string): Observable<Entity> {
    return this.http.patch<Entity>(`${this.apiUrl}/${id}/restore-delete`, {});
  }

  getAllArchived(): Observable<Entity[]> {
    return this.http.get<Entity[]>(`${this.apiUrl}/archived`);
  }

  /**
   * Uploads one file, retrying once if the request dies in transit. A body that
   * arrives truncated (server code TRUNCATED_UPLOAD) or a request that never
   * reached the server at all usually succeeds on a second attempt — on iOS the
   * first try is often what forces an iCloud-backed photo to materialise.
   */
  uploadThumbnail(file: File): Observable<{ url: string; thumbnailUrl: string }> {
    return defer(() => {
      const formData = new FormData();
      formData.append('file', file);
      return this.http.post<{ url: string; thumbnailUrl: string }>('/api/upload', formData);
    }).pipe(
      retry({
        count: 1,
        delay: (err: HttpErrorResponse) => {
          const retryable = err.status === 0 || err.error?.code === 'TRUNCATED_UPLOAD';
          if (!retryable) return throwError(() => err);
          return timer(600);
        },
      })
    );
  }

  /**
   * Queues an image-to-video job on the external receiver, using one stored
   * photo as the start frame. The photo is relayed exactly as stored — still
   * encrypted — so the receiver decrypts it. See POST /api/upload/generate-video.
   */
  generateVideo(url: string, prompt: string, durationSeconds: number): Observable<VideoGenJob> {
    return this.http
      .post<VideoGenJob>('/api/upload/generate-video', { url, prompt, durationSeconds })
      .pipe(
        // The server gives the receiver 60s and then answers, so anything past
        // this is the request itself hanging. Without it a stalled connection
        // leaves the UI waiting with no toast either way.
        timeout(GENERATION_REQUEST_TIMEOUT_MS)
      );
  }

  /**
   * Queues a batch of stills on the external receiver, keeping the face from one
   * stored photo. Relayed for the same reasons as generateVideo() — the photo
   * goes over still encrypted and the receiver sends no CORS headers.
   * See POST /api/upload/generate-images.
   */
  generateImagesFromPhoto(url: string, request: PhotoGenRequest): Observable<PhotoGenJob> {
    return this.http
      .post<PhotoGenJob>('/api/upload/generate-images', { url, ...request })
      .pipe(timeout(GENERATION_REQUEST_TIMEOUT_MS));
  }

  generatePersonality(entityId: string, basicDescription: string): Observable<{ personality: string }> {
    return this.http.post<{ personality: string }>(`${this.apiUrl}/${entityId}/generate-personality`, { basicDescription });
  }

  generateBiography(entityId: string): Observable<{ biography: string }> {
    return this.http.post<{ biography: string }>(`${this.apiUrl}/${entityId}/generate-biography`, {});
  }

  generateImage(
    prompt: string,
    referenceImageUrl?: string,
  ): Observable<{ url: string; thumbnailUrl: string }> {
    return this.http.post<{ url: string; thumbnailUrl: string }>('/api/image/generate', {
      prompt,
      referenceImageUrl,
    });
  }

  getOrCreateNarrator(seriesId: string): Observable<Entity> {
    return this.http.get<Entity>(`${this.apiUrl}/narrator/${seriesId}`);
  }

  reorder(ids: string[]): Observable<void> {
    return this.http.patch<void>(`${this.apiUrl}/reorder`, { ids });
  }

  addPhoto(entityId: string, url: string, thumbnailUrl: string, hidden = false): Observable<Entity> {
    return this.http.post<Entity>(`${this.apiUrl}/${entityId}/photos`, { url, thumbnailUrl, hidden });
  }

  removePhoto(entityId: string, index: number): Observable<Entity> {
    return this.http.delete<Entity>(`${this.apiUrl}/${entityId}/photos/${index}`);
  }

  setPhotosHidden(entityId: string, indices: number[], hidden: boolean): Observable<Entity> {
    return this.http.patch<Entity>(`${this.apiUrl}/${entityId}/photos/visibility`, { indices, hidden });
  }

  /**
   * Moves one photo to another entity. The blob is untouched — only the two
   * `photos` arrays change — so both updated entities come back.
   */
  movePhoto(entityId: string, index: number, targetEntityId: string): Observable<{ source: Entity; target: Entity }> {
    return this.http.post<{ source: Entity; target: Entity }>(
      `${this.apiUrl}/${entityId}/photos/${index}/move`,
      { targetEntityId }
    );
  }

  reorderPhotos(entityId: string, order: number[]): Observable<Entity> {
    return this.http.patch<Entity>(`${this.apiUrl}/${entityId}/photos/reorder`, { order });
  }

  getChapterAppearances(entityId: string): Observable<ChapterAppearance[]> {
    return this.http.get<ChapterAppearance[]>(`${this.apiUrl}/${entityId}/chapters`);
  }

  getMentionCounts(seriesId: string): Observable<{ counts: Record<string, number> }> {
    return this.http.get<{ counts: Record<string, number> }>(`${this.apiUrl}/series/${seriesId}/mention-counts`);
  }
}
