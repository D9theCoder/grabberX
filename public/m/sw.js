// Service worker for the grabberX mobile gallery (/m).
// Caches only static shell assets (_next/static, icons, manifest) and serves an offline fallback page when
// the PC cannot be reached. Media files and account listings are never stored in CacheStorage.
const CACHE_NAME = "gather-m-shell-v1";
const PRECACHE_URLS = ["/manifest.webmanifest", "/m-icons/icon-192.png", "/m-icons/icon-512.png"];

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>grabberX gallery</title>
  <style>
    :root {
      color-scheme: light dark;
      --paper: #fcfcfc;
      --ink: #141414;
      --ink-2: #5c5c5c;
      --on-ink: #fcfcfc;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --paper: #121212;
        --ink: #ededed;
        --ink-2: #a3a3a3;
        --on-ink: #121212;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: max(1.5rem, env(safe-area-inset-top)) 1.5rem max(1.5rem, env(safe-area-inset-bottom));
      background: var(--paper);
      color: var(--ink);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    main {
      width: 100%;
      max-width: 24rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    h1 {
      margin: 0;
      font-size: 1.0625rem;
      line-height: 1.5rem;
      font-weight: 600;
    }
    p {
      margin: 0;
      font-size: 0.9375rem;
      line-height: 1.375rem;
      color: var(--ink-2);
    }
    button {
      margin-top: 0.25rem;
      align-self: flex-start;
      min-height: 2.75rem;
      padding: 0 1rem;
      border: 1px solid var(--ink);
      border-radius: 0.375rem;
      background: var(--ink);
      color: var(--on-ink);
      font: inherit;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <main>
    <h1>Can&#x2019;t reach your PC</h1>
    <p>Check that grabberX is open on your PC with Mobile gallery turned on, and that this phone is on the same network.</p>
    <button type="button" id="retry">Try again</button>
  </main>
  <script>
    document.getElementById("retry").addEventListener("click", function () {
      window.location.reload();
    });
  </script>
</body>
</html>`;

function isStaticShellPath(pathname) {
  return (
    pathname === "/manifest.webmanifest" ||
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/m-icons/")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("gather-m-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "CLEAR_CACHE") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("gather-m-")).map((k) => caches.delete(k)))),
    );
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Never intercept or cache media streams, zip downloads, or API routes.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/m/api/")) return;

  if (isStaticShellPath(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response && response.status === 200) {
            void cache.put(request, response.clone());
          }
          return response;
        } catch (error) {
          throw error;
        }
      }),
    );
    return;
  }

  if (request.mode === "navigate" && (url.pathname === "/m" || url.pathname.startsWith("/m/"))) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(OFFLINE_HTML, {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            },
          }),
      ),
    );
  }
});

