/* VIRGO-01: public shell cache only. Private data and bearer tokens never enter CacheStorage. */
const VERSION = 'a27e88791ec45300';
const CACHE = `virgo-shell-${VERSION}`;
const base = new URL('./', self.registration.scope);
// Chromium CacheStorage rejects custom schemes. Desktop assets are already bundled locally.
const cacheShell = ['https:','http:'].includes(base.protocol);
const shell = ['index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'privacy.html', 'terms.html'];
const sessions = new Map();
function trustedEndpoint(value) {
  try {
    const u = new URL(value);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) return null;
    return u.origin;
  } catch { return null; }
}
self.addEventListener('install', event => {
  if (cacheShell) event.waitUntil(caches.open(CACHE).then(c => c.addAll(shell.map(p => new URL(p, base).href))));
  // Updates wait for the client to save drafts and explicitly activate.
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    if (cacheShell) for (const name of await caches.keys()) if (name.startsWith('virgo-shell-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  event.waitUntil((async () => {
    const source = event.source;
    const data = event.data || {};
    const reply = value => event.ports[0]?.postMessage(value);
    if (!source?.id || !source.url?.startsWith(base.href)) return reply({ok:false});
    if (data.type === 'SKIP_WAITING') { await self.skipWaiting(); return reply({ok:true}); }
    if (data.type === 'VIRGO_LOGOUT') { sessions.delete(source.id); return reply({ok:true}); }
    if (data.type !== 'VIRGO_AUTH') return reply({ok:false});
    const endpoint = trustedEndpoint(data.endpoint);
    if (!endpoint || typeof data.token !== 'string' || data.token.length < 20 || data.token.length > 1024 || /[\r\n]/.test(data.token) || typeof data.stationId !== 'string') return reply({ok:false});
    try {
      const health = await fetch(`${endpoint}/api/health`, {cache:'no-store', credentials:'omit', redirect:'error', signal:AbortSignal.timeout(10000)});
      const identity = await health.json();
      if (!health.ok || !identity.ok || identity.product !== 'VIRGO-01' || identity.stationId !== data.stationId) throw Error('identity');
      sessions.set(source.id, {endpoint, token:data.token, stationId:data.stationId});
      // Clean up credentials for closed tabs; no secret serialization.
      const live = new Set((await self.clients.matchAll({type:'window'})).map(c => c.id));
      for (const id of sessions.keys()) if (!live.has(id)) sessions.delete(id);
      reply({ok:true});
    } catch { reply({ok:false}); }
  })());
});
async function media(request, event, path) {
  const auth = sessions.get(event.clientId);
  if (!auth) return new Response('Sign in again to load this media.', {status:401, headers:{'Cache-Control':'no-store'}});
  const match = /^__virgo_media\/([A-Za-z0-9_-]{1,128})(\/thumbnail)?$/.exec(path);
  if (!match || !['GET','HEAD'].includes(request.method)) return new Response('', {status:400});
  const headers = new Headers({Authorization:`Bearer ${auth.token}`});
  if (request.headers.has('Range')) headers.set('Range', request.headers.get('Range'));
  try {
    const upstream = await fetch(`${auth.endpoint}/api/files/${match[1]}${match[2] || ''}`, {method:request.method,headers,credentials:'omit',cache:'no-store',redirect:'error',signal:request.signal});
    const out = new Headers();
    for (const key of ['content-type','content-length','content-range','accept-ranges','content-disposition','etag']) if (upstream.headers.has(key)) out.set(key, upstream.headers.get(key));
    out.set('Cache-Control','no-store'); out.set('X-Content-Type-Options','nosniff');
    out.set('Content-Security-Policy',"default-src 'none'; sandbox");
    if (upstream.status === 401) sessions.delete(event.clientId);
    return new Response(upstream.body,{status:upstream.status,statusText:upstream.statusText,headers:out});
  } catch { return new Response('Media connection interrupted. Retry when connected.', {status:502,headers:{'Cache-Control':'no-store'}}); }
}
self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
  const path = url.pathname.slice(base.pathname.length);
  if (path.startsWith('__virgo_media/')) { event.respondWith(media(req,event,path)); return; }
  if (!cacheShell) return;
  if (req.method !== 'GET' || path === 'server.json' || path.startsWith('api/') || path.startsWith('admin-api/')) return;
  if (req.mode === 'navigate' && (path === '' || path === 'index.html')) {
    event.respondWith(fetch(req).catch(() => caches.match(new URL('index.html',base).href)));
  } else if (shell.includes(path)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(new URL(path,base).href)) || fetch(req)));
  }
});
