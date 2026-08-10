/**
 * Detect when the page you're looking at is an old build.
 *
 * GitHub Pages serves index.html with a short cache lifetime, and Vite gives
 * every JS bundle a content-hashed filename. So a cached index.html keeps
 * pointing at the *old* bundle, and the app silently runs stale code — twice
 * during development this looked exactly like a bug that had already been
 * fixed, and cost a full debugging round trip each time.
 *
 * The check compares the script tag this page actually loaded against the one
 * the server is serving right now, fetched with `cache: 'no-store'` so it can't
 * be answered from the same stale cache. No version file to keep in sync and
 * nothing to remember to bump — the bundle hash already changes on every build.
 */

const POLL_MS = 5 * 60 * 1000;

function loadedScriptPath(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  if (!el) return null;
  return new URL(el.src, location.href).pathname;
}

async function servedScriptPath(): Promise<string | null> {
  const res = await fetch(location.href, { cache: 'no-store' });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
  return m ? new URL(m[1], location.href).pathname : null;
}

/**
 * Calls `onStale` once when a newer build is detected, then stops checking.
 * Silent in dev, where the entry is unhashed and always /src/main.ts.
 */
export function watchForNewBuild(onStale: () => void): void {
  const current = loadedScriptPath();
  if (!current || current.startsWith('/src/')) return;

  let stopped = false;
  const check = async () => {
    if (stopped) return;
    try {
      const latest = await servedScriptPath();
      if (latest && latest !== current) {
        stopped = true;
        onStale();
      }
    } catch {
      // Offline or blocked. Nothing useful to say; try again later.
    }
  };

  check();
  const timer = setInterval(() => {
    if (stopped) clearInterval(timer);
    else void check();
  }, POLL_MS);

  // A tab left open overnight should notice as soon as it's used again.
  addEventListener('focus', () => void check());
}
