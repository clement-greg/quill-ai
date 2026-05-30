import {
  Component,
  inject,
  signal,
  computed,
  ElementRef,
  AfterViewInit,
  ViewChild,
  OnDestroy,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { PinLockService } from '../services/pin-lock.service';

@Component({
  selector: 'app-pin-entry-overlay',
  imports: [MatButtonModule, MatIconModule],
  templateUrl: './pin-entry-overlay.html',
  styleUrl: './pin-entry-overlay.scss',
})
export class PinEntryOverlayComponent implements AfterViewInit, OnDestroy {
  private pinLock = inject(PinLockService);

  @ViewChild('pinCapture') pinCaptureRef!: ElementRef<HTMLInputElement>;

  pinValue = signal('');
  checking = signal(false);
  error = signal(false);

  /** Each entered digit shown as a filled dot */
  pinDisplay = computed<boolean[]>(() =>
    this.pinValue().split('').map(() => true)
  );

  ngAfterViewInit(): void {
    setTimeout(() => this.pinCaptureRef?.nativeElement?.focus(), 50);
  }

  ngOnDestroy(): void {}

  focusInput(): void {
    this.pinCaptureRef?.nativeElement?.focus();
  }

  onInput(event: Event): void {
    // Strip non-digits so type="tel" doesn't sneak in +, -, etc.
    const raw = (event.target as HTMLInputElement).value.replace(/\D/g, '');
    this.pinValue.set(raw);
    (event.target as HTMLInputElement).value = raw;
    this.error.set(false);
  }

  async submit(): Promise<void> {
    const pin = this.pinValue().trim();
    if (!pin || this.checking()) return;
    this.checking.set(true);
    this.error.set(false);
    const ok = await this.pinLock.unlock(pin);
    this.checking.set(false);
    if (!ok) {
      this.error.set(true);
      this.pinValue.set('');
      this.pinCaptureRef.nativeElement.value = '';
      setTimeout(() => this.pinCaptureRef?.nativeElement?.focus(), 50);
    }
  }
}
