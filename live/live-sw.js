// No personal content is cached. Only the Live entrance has an offline response.
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
const root=new URL(self.registration.scope);
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.mode!=='navigate' || req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==root.origin || (url.pathname!==root.pathname && url.pathname!==root.pathname+'index.html'))return;
  event.respondWith(fetch(req).catch(()=>new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>VIRGO Live · 离线</title><style>body{font:1rem system-ui,sans-serif;margin:0;min-height:100svh;display:grid;place-items:center}main{padding:1.5rem;max-width:23rem}h1{font-size:1.7rem}button{font:inherit;padding:.8rem 1.4rem;border-radius:1.5rem}</style><main><b>VIRGO Live</b><h1>当前没有网络连接</h1><p>联网后会重新打开直播。你也可以手动重试。</p><button type="button" onclick="location.reload()">重新连接</button></main><script>addEventListener('online',()=>location.reload(),{once:true})</script></html>`,{headers:{'Content-Type':'text/html; charset=UTF-8','Cache-Control':'no-store'}})));
});
