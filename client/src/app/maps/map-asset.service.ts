import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, switchMap } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { MapAsset } from '@shared/models/map-asset.model';

@Injectable({ providedIn: 'root' })
export class MapAssetService {
  private http = inject(HttpClient);
  private readonly apiUrl = '/api/map-assets';

  getBySeries(seriesId: string): Observable<MapAsset[]> {
    return this.http.get<MapAsset[]>(`${this.apiUrl}/series/${seriesId}`);
  }

  create(asset: MapAsset): Observable<MapAsset> {
    return this.http.post<MapAsset>(this.apiUrl, asset);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }

  /**
   * Uploads an image (reusing the shared /api/upload pipeline that produces a
   * full-size blob and a thumbnail) and registers it as a palette asset for
   * the series.
   */
  upload(seriesId: string, file: File, name: string, category?: string): Observable<MapAsset> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http
      .post<{ url: string; thumbnailUrl: string }>('/api/upload', formData)
      .pipe(
        switchMap(({ url, thumbnailUrl }) =>
          this.create({
            id: uuidv4(),
            seriesId,
            name,
            ...(category ? { category } : {}),
            imageUrl: url,
            thumbnailUrl,
          }),
        ),
      );
  }
}
