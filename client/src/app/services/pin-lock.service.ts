import { Injectable, inject, signal } from '@angular/core';
import { UserSettingsService } from './user-settings.service';

/** Manages the PIN-based lock state for photo areas. */
@Injectable({ providedIn: 'root' })
export class PinLockService {
  private settingsService = inject(UserSettingsService);

  private _isLocked = signal(true);
  readonly isLocked = this._isLocked.asReadonly();
  readonly hasPin = this.settingsService.hasPin;

  constructor() {
    // Auto-lock when the app loses visibility (tab switch, minimize, etc.)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.hasPin()) {
        this._isLocked.set(true);
      }
    });
  }

  /** Lock the PIN-protected areas immediately. */
  lock(): void {
    this._isLocked.set(true);
  }

  /**
   * Attempt to unlock with the given PIN.
   * Returns true if the PIN was correct.
   */
  async unlock(pin: string): Promise<boolean> {
    const hash = await this.hashPin(pin);
    if (hash === this.settingsService.pinHash()) {
      this._isLocked.set(false);
      return true;
    }
    return false;
  }

  /**
   * Set a new PIN.
   * If a PIN is already set, `currentPin` must be provided and correct.
   * After setting, the lock is engaged so the user must confirm the new PIN works.
   * Returns true on success.
   */
  async setPin(newPin: string, currentPin?: string): Promise<boolean> {
    if (this.hasPin()) {
      if (!currentPin) return false;
      const currentHash = await this.hashPin(currentPin);
      if (currentHash !== this.settingsService.pinHash()) return false;
    }
    const hash = await this.hashPin(newPin);
    this.settingsService.setPinHash(hash);
    // Engage the lock so the user verifies the new PIN works
    this._isLocked.set(true);
    return true;
  }

  /**
   * Remove the PIN. Requires the current PIN to confirm.
   * Returns true on success.
   */
  async clearPin(currentPin: string): Promise<boolean> {
    const hash = await this.hashPin(currentPin);
    if (hash !== this.settingsService.pinHash()) return false;
    this.settingsService.clearPinHash();
    this._isLocked.set(false);
    return true;
  }

  private async hashPin(pin: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(`quill-pin:${pin}`);
    const buffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
