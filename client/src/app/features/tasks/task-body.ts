import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TaskLink, segmentTaskBody } from '@shared/models/task.model';

/** A task's body with the entities and chapters it mentions turned into links. */
@Component({
  selector: 'app-task-body',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (seg of segments(); track $index) {@if (seg.link; as link) {<a
        class="task-link"
        [class.chapter]="link.kind === 'chapter'"
        [routerLink]="linkRoute(link)"
        [attr.title]="link.name ?? null"
        (click)="$event.stopPropagation()"
      >{{ seg.text }}</a>} @else {{{ seg.text }}}}`,
  styles: [`
    :host { white-space: pre-wrap; word-break: break-word; }
    .task-link {
      color: var(--mat-sys-primary);
      text-decoration: underline;
      text-decoration-style: dotted;
      text-underline-offset: 3px;
      font-weight: 500;
    }
    .task-link:hover, .task-link:focus-visible { text-decoration-style: solid; }
  `],
})
export class TaskBodyComponent {
  readonly body = input<string | undefined>('');
  readonly links = input<TaskLink[] | undefined>([]);

  readonly segments = computed(() => segmentTaskBody(this.body() ?? '', this.links()));

  linkRoute(link: TaskLink): string[] {
    return link.kind === 'chapter' ? ['/chapters', link.id, 'edit'] : ['/entities', link.id];
  }
}
