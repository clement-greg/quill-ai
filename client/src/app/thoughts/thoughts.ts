import {
  Component,
  inject,
  signal,
  computed,
  OnInit,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TextFieldModule } from '@angular/cdk/text-field';
import { ThoughtsService } from '../services/thoughts.service';
import { HeaderService } from '../services/header.service';
import { Thought } from '@shared/models/thought.model';
import { v4 as uuidv4 } from 'uuid';
import { SlideOutPanelContainer } from '../shared/slide-out-panel-container/slide-out-panel-container';

@Component({
  selector: 'app-thoughts',
  imports: [
    FormsModule,
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatProgressSpinnerModule,
    MatChipsModule,
    MatDividerModule,
    TextFieldModule,
    SlideOutPanelContainer,
  ],
  templateUrl: './thoughts.html',
  styleUrl: './thoughts.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThoughtsComponent implements OnInit {
  private thoughtsService = inject(ThoughtsService);
  private headerService = inject(HeaderService);
  private fb = inject(FormBuilder);
  private snackBar = inject(MatSnackBar);

  thoughts = signal<Thought[]>([]);
  loading = signal(false);
  showPanel = signal(false);
  editingThought = signal<Thought | null>(null);
  isNew = signal(false);
  saving = signal(false);

  form: FormGroup = this.fb.group({
    title: [''],
    content: ['', Validators.required],
  });

  sortedThoughts = computed(() =>
    [...this.thoughts()].sort(
      (a, b) =>
        new Date(b.modifiedAt ?? b.createdAt ?? 0).getTime() -
        new Date(a.modifiedAt ?? a.createdAt ?? 0).getTime(),
    ),
  );

  ngOnInit(): void {
    this.headerService.clearAll();
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.thoughtsService.getAll().subscribe({
      next: (data) => {
        this.thoughts.set(data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  openNew(): void {
    this.isNew.set(true);
    this.editingThought.set(null);
    this.form.reset({ title: '', content: '' });
    this.showPanel.set(true);
  }

  openEdit(thought: Thought): void {
    this.isNew.set(false);
    this.editingThought.set(thought);
    this.form.setValue({ title: thought.title ?? '', content: thought.content });
    this.showPanel.set(true);
  }

  onPanelChanged(open: boolean): void {
    this.showPanel.set(open);
    if (!open) this.editingThought.set(null);
  }

  closePanel(): void {
    this.showPanel.set(false);
    this.editingThought.set(null);
  }

  save(): void {
    if (this.form.invalid || this.saving()) return;

    const { title, content } = this.form.getRawValue() as { title: string; content: string };
    this.saving.set(true);

    if (this.isNew()) {
      const thought: Partial<Thought> = {
        id: uuidv4(),
        title: title.trim() || undefined,
        content: content.trim(),
      };
      this.thoughtsService.create(thought).subscribe({
        next: (created) => {
          this.thoughts.update((list) => [created, ...list]);
          this.saving.set(false);
          this.closePanel();
        },
        error: () => this.saving.set(false),
      });
    } else {
      const existing = this.editingThought();
      if (!existing) return;
      this.thoughtsService
        .update(existing.id, {
          title: title.trim() || undefined,
          content: content.trim(),
        })
        .subscribe({
          next: (updated) => {
            this.thoughts.update((list) =>
              list.map((t) => (t.id === updated.id ? updated : t)),
            );
            this.saving.set(false);
            this.closePanel();
          },
          error: () => this.saving.set(false),
        });
    }
  }

  delete(thought: Thought): void {
    this.thoughtsService.delete(thought.id).subscribe({
      next: () => {
        this.thoughts.update((list) => list.filter((t) => t.id !== thought.id));
        if (this.editingThought()?.id === thought.id) this.closePanel();

        const ref = this.snackBar.open('Thought deleted', 'Undo', { duration: 5000 });
        ref.onAction().subscribe(() => {
          this.thoughtsService.restore(thought.id).subscribe({
            next: (restored) => {
              this.thoughts.update((list) => [restored, ...list]);
            },
          });
        });
      },
    });
  }

  formatDate(iso: string | undefined): string {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
}
