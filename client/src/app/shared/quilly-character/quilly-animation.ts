import { Injectable } from '@angular/core';

/** A single frame entry inside a Ludo.ai sprite-sheet JSON descriptor. */
export interface QuillyRawFrame {
  frame: { x: number; y: number; w: number; h: number };
  duration: number;
}

/** Shape of the sprite-sheet JSON files in `/public/quilly`. */
export interface QuillySpriteSheet {
  frames: Record<string, QuillyRawFrame>;
  meta: { image: string; size: { w: number; h: number } };
}

/** A loaded, ready-to-draw animation: the decoded image plus ordered frames. */
export interface QuillyLoadedAnimation {
  image: HTMLImageElement;
  frames: QuillyRawFrame[];
}

/** Identifiers for every available animation sequence. */
export type QuillySequenceId =
  | 'idle'
  | 'talking'
  | 'dance'
  | 'angry'
  | 'confused'
  | 'crying'
  | 'flames'
  | 'rain-cloud'
  | 'hearts'
  | 'hands-raised'
  | 'quizzical';

export interface QuillySequenceMeta {
  id: QuillySequenceId;
  label: string;
  /** Base file name (shared by the `.json` and `.png`) under the base path. */
  file: string;
}

/** Catalog of the animation sequences shipped in `/public/quilly`. */
export const QUILLY_SEQUENCES: readonly QuillySequenceMeta[] = [
  { id: 'idle', label: 'Idle', file: 'Character-is-in-an-i' },
  { id: 'talking', label: 'Talking', file: 'Character-is-talking' },
  { id: 'dance', label: 'Little dance', file: 'Does-a-little-dance-' },
  { id: 'angry', label: 'Very angry', file: 'Get-s-a-VERY-angry-l' },
  { id: 'confused', label: 'Confused', file: 'Looks-confused-scra' },
  { id: 'crying', label: 'Crying', file: 'begins-crying-tears' },
  { id: 'flames', label: 'Bursts into flames', file: 'Bursts-into-flames' },
  { id: 'rain-cloud', label: 'Rain cloud', file: 'A-rain-cloud-forms-o' },
  { id: 'hearts', label: 'Heart emojis', file: 'heart-emojis-bubble-' },
  { id: 'hands-raised', label: 'Hands raised', file: 'raised-the-hands-in-' },
  { id: 'quizzical', label: 'Quizzical', file: 'The-character-is-a-q' },
] as const;

const SEQUENCE_BY_ID = new Map(QUILLY_SEQUENCES.map((s) => [s.id, s]));

export function quillySequenceMeta(id: QuillySequenceId): QuillySequenceMeta | undefined {
  return SEQUENCE_BY_ID.get(id);
}

/**
 * Loads and caches Quilly sprite-sheet animations (JSON descriptor + PNG atlas).
 * Each animation is fetched at most once per base path.
 */
@Injectable({ providedIn: 'root' })
export class QuillyAnimationService {
  private readonly cache = new Map<string, Promise<QuillyLoadedAnimation>>();

  load(file: string, basePath: string): Promise<QuillyLoadedAnimation> {
    const key = `${basePath}/${file}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.fetchAnimation(file, basePath);
      this.cache.set(key, pending);
    }
    return pending;
  }

  loadById(id: QuillySequenceId, basePath: string): Promise<QuillyLoadedAnimation> {
    const meta = quillySequenceMeta(id);
    if (!meta) {
      return Promise.reject(new Error(`Unknown Quilly sequence: ${id}`));
    }
    return this.load(meta.file, basePath);
  }

  private async fetchAnimation(file: string, basePath: string): Promise<QuillyLoadedAnimation> {
    const response = await fetch(`${basePath}/${file}.json`);
    if (!response.ok) {
      throw new Error(`Failed to load Quilly sheet "${file}": ${response.status}`);
    }
    const sheet = (await response.json()) as QuillySpriteSheet;
    const frames = this.orderFrames(sheet);
    const image = await this.loadImage(`${basePath}/${file}.png`);
    return { image, frames };
  }

  /** Sort frames by their numeric `frame_NNN` key so playback order is stable. */
  private orderFrames(sheet: QuillySpriteSheet): QuillyRawFrame[] {
    return Object.keys(sheet.frames)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => sheet.frames[name]);
  }

  private loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load Quilly image: ${src}`));
      img.src = src;
    });
  }
}
