let mapsLoaderPromise: Promise<typeof google.maps> | undefined;

async function fetchMapsKey(): Promise<string> {
  const res = await fetch('/api/config/maps-key');
  if (!res.ok) throw new Error('Failed to fetch Maps API key');
  const { key } = await res.json() as { key: string };
  return key;
}

export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (mapsLoaderPromise) return mapsLoaderPromise;
  mapsLoaderPromise = (async () => {
    if (typeof google !== 'undefined' && google.maps) return google.maps;
    const apiKey = await fetchMapsKey();
    return new Promise<typeof google.maps>((resolve, reject) => {
      const callbackName = '__quillGoogleMapsReady';
      (window as unknown as Record<string, () => void>)[callbackName] = () => resolve(google.maps);
      const script = document.createElement('script');
      const params = new URLSearchParams({
        key: apiKey,
        callback: callbackName,
        loading: 'async',
        libraries: 'marker',
      });
      script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
      script.async = true;
      script.onerror = () => reject(new Error('Failed to load Google Maps'));
      document.head.appendChild(script);
    });
  })();
  return mapsLoaderPromise;
}
