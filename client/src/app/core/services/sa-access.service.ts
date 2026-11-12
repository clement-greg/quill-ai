import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SaMeResponse } from '@shared/models/sa-access.model';

/** Whether the signed-in user has SA (administrator) access. */
@Injectable({ providedIn: 'root' })
export class SaAccessService {
  private http = inject(HttpClient);
  private _isSa = signal(false);
  readonly isSa = this._isSa.asReadonly();

  async load(): Promise<void> {
    try {
      const { isSa } = await firstValueFrom(this.http.get<SaMeResponse>('/api/sa/me'));
      this._isSa.set(isSa);
    } catch {
      this._isSa.set(false);
    }
  }
}
