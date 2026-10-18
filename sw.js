/* VIRGO-01: public shell cache only. Private data and bearer tokens never enter CacheStorage. */
const VERSION = '28e2a609eea801f1';
const CACHE = `virgo-shell-${VERSION}`;
const base = new URL('./', self.registration.scope);
// Chromium CacheStorage rejects custom schemes. Desktop assets are already bundled locally.
const cacheShell = ['https:','http:'].includes(base.protocol);
const shell = ['index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'privacy.html', 'terms.html'];
const sessions = new Map();
function revokeMedia(id){const current=sessions.get(id);sessions.delete(id);for(const controller of current?.requests||[])controller.abort()}
let pushBinding,bindingRevision=0,bindingWrites=Promise.resolve();
function bindingStore(mode,operation){
  if(typeof indexedDB==='undefined')return Promise.resolve(operation(null));
  return new Promise((resolve,reject)=>{const opening=indexedDB.open('virgo-push-device',1);opening.onupgradeneeded=()=>opening.result.createObjectStore('binding');opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result,tx=db.transaction('binding',mode),request=operation(tx.objectStore('binding'));tx.oncomplete=()=>{resolve(request?.result);db.close()};tx.onerror=()=>{reject(tx.error);db.close()}}});
}
async function readPushBinding(){await bindingWrites;if(pushBinding!==undefined)return pushBinding;const revision=bindingRevision,value=await bindingStore('readonly',store=>store?.get('current'));if(revision===bindingRevision)pushBinding=value;return pushBinding||null}
async function writePushBinding(value){const revision=++bindingRevision;pushBinding=null;bindingWrites=bindingWrites.catch(()=>{}).then(()=>bindingStore('readwrite',store=>value?store?.put(value,'current'):store?.delete('current')));await bindingWrites;if(revision===bindingRevision)pushBinding=value;}
async function disablePush(){await writePushBinding(null);for(const notification of await self.registration.getNotifications?.()||[])notification.close()}
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
    if (data.type === 'VIRGO_LOGOUT') { revokeMedia(source.id); await disablePush();return reply({ok:true}); }
    if (data.type === 'VIRGO_PUSH_STATUS') return reply({ok:true,binding:await readPushBinding()});
    if (data.type === 'VIRGO_PUSH_DISABLE') {await disablePush();return reply({ok:true});}
    if (data.type === 'VIRGO_PUSH_BIND') {
      if(typeof data.stationId!=='string'||data.stationId.length>80||!Number.isSafeInteger(data.accountId)||data.accountId<=0)return reply({ok:false});
      await writePushBinding({stationId:data.stationId,accountId:data.accountId});return reply({ok:true});
    }
    if (data.type !== 'VIRGO_AUTH') return reply({ok:false});
    // The binding object is a per-tab generation. Logout or a newer message
    // invalidates pending health checks and all media using older credentials.
    revokeMedia(source.id);
    const endpoint = trustedEndpoint(data.endpoint);
    if (!endpoint || typeof data.token !== 'string' || data.token.length < 20 || data.token.length > 1024 || /[\r\n]/.test(data.token) || typeof data.stationId !== 'string') return reply({ok:false});
    const binding={endpoint,token:data.token,stationId:data.stationId,verified:false,requests:new Set()};
    sessions.set(source.id,binding);
    try {
      const health = await fetch(`${endpoint}/api/health`, {cache:'no-store', credentials:'omit', redirect:'error', signal:AbortSignal.timeout(10000)});
      const identity = await health.json();
      if (!health.ok || !identity.ok || identity.product !== 'VIRGO-01' || identity.stationId !== data.stationId) throw Error('identity');
      if(sessions.get(source.id)!==binding)return reply({ok:false});
      binding.verified=true;
      // Clean up credentials for closed tabs; no secret serialization.
      const live = new Set((await self.clients.matchAll({type:'window'})).map(c => c.id));
      for (const id of sessions.keys()) if (!live.has(id)) revokeMedia(id);
      reply({ok:true});
    } catch { if(sessions.get(source.id)===binding)revokeMedia(source.id);reply({ok:false}); }
  })());
});
function pushNavigation(data){
  if(!data||typeof data.stationId!=='string'||data.stationId.length>80||!Number.isSafeInteger(data.accountId)||data.accountId<=0)return null;
  const value={stationId:data.stationId,accountId:data.accountId};
  if(Number.isSafeInteger(data.roomId)&&data.roomId>0)value.roomId=data.roomId;
  if(typeof data.callId==='string'&&/^[a-f0-9-]{36}$/.test(data.callId))value.callId=data.callId;
  if(data.kind==='friend'||data.tab==='friends')value.tab='friends';else if(data.kind==='call'||data.tab==='calls')value.tab='calls';
  return value;
}
self.addEventListener('push',event=>event.waitUntil((async()=>{
  let data;try{data=event.data?.json()}catch{return}
  const navigation=pushNavigation(data),binding=await readPushBinding();
  if(!navigation||data.v!==1||!binding||pushBinding!==binding||binding.stationId!==navigation.stationId||binding.accountId!==navigation.accountId||!['message','friend','call','test'].includes(data.kind)||!Number.isFinite(data.expiresAt)||data.expiresAt<=Date.now())return;
  const title=typeof data.title==='string'?data.title.slice(0,80):'VIRGO-01',body=typeof data.body==='string'?data.body.slice(0,240):'';
  await self.registration.showNotification(title,{body,tag:typeof data.tag==='string'?data.tag.slice(0,64):'virgo-message',icon:new URL('icon-192.png',base).href,badge:new URL('icon-192.png',base).href,data:navigation,renotify:false});
})()));
self.addEventListener('notificationclick',event=>{
  event.notification.close();event.waitUntil((async()=>{
    const value=pushNavigation(event.notification.data);if(!value)return;
    // Keep destinations inside this app. Never accept a URL from a payload.
    const binding=await readPushBinding();if(!binding||binding.stationId!==value.stationId||binding.accountId!==value.accountId)return;
    const url=new URL('./',base);url.hash='notify='+encodeURIComponent(JSON.stringify(value));
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(client=>{try{const candidate=new URL(client.url);return candidate.origin===base.origin&&candidate.pathname.startsWith(base.pathname)}catch{return false}});
    if(existing){existing.postMessage({type:'VIRGO_NOTIFICATION_NAVIGATE',...value});await existing.focus()}else await self.clients.openWindow(url.href);
  })());
});
self.addEventListener('pushsubscriptionchange',event=>event.waitUntil(disablePush()));
async function media(request, event, path) {
  const auth = sessions.get(event.clientId);
  if (!auth?.verified) return new Response('Sign in again to load this media.', {status:401, headers:{'Cache-Control':'no-store'}});
  const match = /^__virgo_media\/([A-Za-z0-9_-]{1,128})(\/thumbnail)?$/.exec(path);
  if (!match || !['GET','HEAD'].includes(request.method)) return new Response('', {status:400});
  const headers = new Headers({Authorization:`Bearer ${auth.token}`});
  if (request.headers.has('Range')) headers.set('Range', request.headers.get('Range'));
  const controller=new AbortController(),abort=()=>controller.abort();auth.requests.add(controller);
  request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
  const cleanup=()=>{auth.requests.delete(controller);request.signal.removeEventListener('abort',abort)};
  try {
    const upstream = await fetch(`${auth.endpoint}/api/files/${match[1]}${match[2] || ''}`, {method:request.method,headers,credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
    if(sessions.get(event.clientId)!==auth){await upstream.body?.cancel().catch(()=>{});cleanup();return new Response('Session changed.',{status:401,headers:{'Cache-Control':'no-store'}})}
    const out = new Headers();
    for (const key of ['content-type','content-length','content-range','accept-ranges','content-disposition','etag']) if (upstream.headers.has(key)) out.set(key, upstream.headers.get(key));
    out.set('Cache-Control','no-store'); out.set('X-Content-Type-Options','nosniff');
    out.set('Content-Security-Policy',"default-src 'none'; sandbox");
    if (upstream.status === 401) {revokeMedia(event.clientId);await upstream.body?.cancel().catch(()=>{});cleanup();out.delete('Content-Length');out.delete('Content-Range');out.set('Content-Type','text/plain; charset=utf-8');return new Response('Sign in again to load this media.',{status:401,headers:out})}
    let body=null;
    if(upstream.body){const reader=upstream.body.getReader();body=new ReadableStream({async pull(output){try{const chunk=await reader.read();if(sessions.get(event.clientId)!==auth)throw Error('Session changed');if(chunk.done){cleanup();output.close()}else output.enqueue(chunk.value)}catch(error){cleanup();await reader.cancel().catch(()=>{});output.error(error)}},cancel(reason){cleanup();controller.abort();return reader.cancel(reason)}})}else cleanup();
    return new Response(body,{status:upstream.status,statusText:upstream.statusText,headers:out});
  } catch { cleanup();return new Response('Media connection interrupted. Retry when connected.', {status:502,headers:{'Cache-Control':'no-store'}}); }
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
