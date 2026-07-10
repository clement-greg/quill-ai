import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { SeriesMap } from '@shared/models/map.model';

@Injectable({ providedIn: 'root' })
export class MapService {
  private http = inject(HttpClient);
  private readonly apiUrl = '/api/maps';

  getBySeries(seriesId: string): Observable<SeriesMap[]> {
    return this.http.get<SeriesMap[]>(`${this.apiUrl}/series/${seriesId}`);
  }

  getById(id: string): Observable<SeriesMap> {
    return this.http.get<SeriesMap>(`${this.apiUrl}/${id}`);
  }

  create(map: SeriesMap): Observable<SeriesMap> {
    return this.http.post<SeriesMap>(this.apiUrl, map);
  }

  update(map: SeriesMap): Observable<SeriesMap> {
    return this.http.put<SeriesMap>(`${this.apiUrl}/${map.id}`, map);
  }

  archive(id: string): Observable<SeriesMap> {
    return this.http.patch<SeriesMap>(`${this.apiUrl}/${id}/archive`, {});
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }
}
