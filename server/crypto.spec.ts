import { encrypt, decrypt } from './crypto';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

describe('crypto', () => {
  it('round-trips text data', () => {
    const plaintext = Buffer.from('The quick brown fox jumps over the lazy dog', 'utf8');
    expect(decrypt(encrypt(plaintext)).toString('utf8')).toBe(plaintext.toString('utf8'));
  });

  it('round-trips binary data', () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    expect(decrypt(encrypt(bytes)).equals(bytes)).toBe(true);
  });

  it('round-trips an empty buffer', () => {
    expect(decrypt(encrypt(Buffer.alloc(0))).length).toBe(0);
  });

  it('stores IV, auth tag, and ciphertext in the documented layout', () => {
    const plaintext = Buffer.from('hello');
    const encrypted = encrypt(plaintext);
    // GCM ciphertext is the same length as the plaintext.
    expect(encrypted.length).toBe(IV_LENGTH + TAG_LENGTH + plaintext.length);
  });

  it('uses a fresh IV per call, so identical plaintexts encrypt differently', () => {
    const plaintext = Buffer.from('same input');
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(0, IV_LENGTH).equals(b.subarray(0, IV_LENGTH))).toBe(false);
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encrypt(Buffer.from('sensitive'));
    encrypted[encrypted.length - 1] ^= 0xff;
    expect(() => decrypt(encrypted)).toThrow();
  });

  it('rejects a tampered auth tag', () => {
    const encrypted = encrypt(Buffer.from('sensitive'));
    encrypted[IV_LENGTH] ^= 0xff;
    expect(() => decrypt(encrypted)).toThrow();
  });
});
