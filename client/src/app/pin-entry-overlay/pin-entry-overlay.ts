import {
  Component,
  inject,
  signal,
  ElementRef,
  AfterViewInit,
  ViewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { PinLockService } from '../services/pin-lock.service';

@Component({
  selector: 'app-pin-entry-overlay',
  imports: [MatButtonModule, MatIconModule, MatInputModule, MatFormFieldModule],
  templateUrl: './pin-entry-overlay.html',
  styleUrl: './pin-entry-overlay.scss',
})
export class PinEntryOverlayComponent implements AfterViewInit {
  private pinLock = inject(PinLockService);

  @ViewChild('pinInput') pinInputRef!: ElementRef<HTMLInputElement>;

  pinValue = signal('');
  checking = signal(false);
  error = signal(false);

  ngAfterViewInit(): void {
    // Auto-focus the PIN field when the overlay appears
    setTimeout(() => this.pinInputRef?.nativeElement?.focus(), 50);
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
      setTimeout(() => this.pinInputRef?.nativeElement?.focus(), 50);
    }
  }
}
