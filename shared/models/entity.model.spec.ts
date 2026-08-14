import { isVideoUrl } from './entity.model';

describe('isVideoUrl', () => {
  it.each(['.mp4', '.webm', '.mov', '.m4v', '.ogv'])('recognises %s as video', ext => {
    expect(isVideoUrl(`https://acct.blob.core.windows.net/media/uuid${ext}`)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isVideoUrl('https://acct.blob.core.windows.net/media/uuid.MP4')).toBe(true);
  });

  it.each(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'])('treats %s as not video', ext => {
    expect(isVideoUrl(`https://acct.blob.core.windows.net/media/uuid${ext}`)).toBe(false);
  });

  it('ignores query strings and fragments', () => {
    expect(isVideoUrl('/api/image/uuid.mp4#t=0.1')).toBe(true);
    expect(isVideoUrl('/api/image/uuid.mp4?v=2')).toBe(true);
    expect(isVideoUrl('/api/image/uuid.png?name=clip.mp4')).toBe(false);
  });

  it('handles missing urls', () => {
    expect(isVideoUrl(undefined)).toBe(false);
    expect(isVideoUrl(null)).toBe(false);
    expect(isVideoUrl('')).toBe(false);
  });
});
