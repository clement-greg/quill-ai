import { ChangeDetectionStrategy, Component, signal, viewChild } from '@angular/core';
import {
  QuillyCharacterComponent,
  QuillySpeechPosition,
} from '@app/shared/quilly-character/quilly-character';
import {
  QUILLY_SEQUENCES,
  QuillySequenceId,
} from '@app/shared/quilly-character/quilly-animation';

@Component({
  selector: 'app-quilly-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QuillyCharacterComponent],
  templateUrl: './quilly-demo.html',
  styleUrl: './quilly-demo.scss',
})
export class QuillyDemoComponent {
  protected readonly sequences = QUILLY_SEQUENCES;
  protected readonly current = signal<QuillySequenceId>('idle');
  protected readonly loop = signal(true);
  protected readonly size = signal(280);
  protected readonly lastCompleted = signal<string | null>(null);
  protected readonly speechInput = signal('Hi, I\'m Quilly!');
  protected readonly speechSeconds = signal(0);
  protected readonly speechPosition = signal<QuillySpeechPosition>('above');
  protected readonly positions: readonly QuillySpeechPosition[] = ['above', 'left', 'right'];

  private readonly character =
    viewChild.required<QuillyCharacterComponent>('character');

  protected select(id: QuillySequenceId): void {
    this.lastCompleted.set(null);
    this.current.set(id);
  }

  protected replay(): void {
    this.lastCompleted.set(null);
    this.character().play(this.current());
  }

  protected toggleLoop(): void {
    this.loop.update((v) => !v);
  }

  protected onSize(event: Event): void {
    this.size.set(Number((event.target as HTMLInputElement).value));
  }

  protected onComplete(id: QuillySequenceId): void {
    const label = this.sequences.find((s) => s.id === id)?.label ?? id;
    this.lastCompleted.set(label);
  }

  protected onSpeechText(event: Event): void {
    this.speechInput.set((event.target as HTMLInputElement).value);
  }

  protected onSpeechSeconds(event: Event): void {
    this.speechSeconds.set(Number((event.target as HTMLInputElement).value));
  }

  protected setPosition(position: QuillySpeechPosition): void {
    this.speechPosition.set(position);
  }

  protected say(): void {
    this.character().say(this.speechInput(), this.speechSeconds() * 1000);
  }
}
