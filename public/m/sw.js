// Pass-through service worker. It exists so Chrome treats the gallery as an installable app over HTTPS.
// It caches nothing: the library is large and private, and the PC is the only copy that matters.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
