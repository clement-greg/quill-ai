import {
  Component,
  inject,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { PinLockService } from '../services/pin-lock.service';
import { PinEntryOverlayComponent } from '../pin-entry-overlay/pin-entry-overlay';
import { EntityPhoto } from '@shared/models/entity.model';

export interface PhotoPickerResult {
  url: string;
  thumbnailUrl: string;
}

@Component({
  selector: 'app-photo-picker-dialog',
  imports: [
    MatButtonModule,
    MatIconModule,
    PinEntryOverlayComponent,
  ],
  templateUrl: './photo-picker-dialog.html',
  styleUrl: './photo-picker-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoPickerDialogComponent {
  private dialogRef = inject(MatDialogRef<PhotoPickerDialogComponent>);
  private data = inject<EntityPhoto[]>(MAT_DIALOG_DATA);
  readonly pinLock = inject(PinLockService);

  photos = computed(() => this.data.filter(p => !p.hidden));

  proxyUrl(url: string): string {
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : url;
  }

  select(photo: PhotoPickerResult): void {
    this.dialogRef.close(photo);
  }

  close(): void {
    this.dialogRef.close();
  }
}
