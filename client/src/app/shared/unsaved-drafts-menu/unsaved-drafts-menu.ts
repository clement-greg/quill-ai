import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatMenuModule } from '@angular/material/menu';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { UnsavedDraftsService } from '@app/features/chapters/chapter-edit/unsaved-drafts.service';

@Component({
  selector: 'app-unsaved-drafts-menu',
  imports: [RouterLink, MatMenuModule, MatIconModule, MatButtonModule],
  templateUrl: './unsaved-drafts-menu.html',
  styleUrl: './unsaved-drafts-menu.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UnsavedDraftsMenuComponent {
  private unsavedDrafts = inject(UnsavedDraftsService);

  draftChapters = this.unsavedDrafts.chapters;

  count = computed(() => this.draftChapters().length);

  proxyUrl(url: string | undefined): string | null {
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }
}
