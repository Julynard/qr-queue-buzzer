// QR Queue Buzzer — test version with push alerts + screen-awake
// Setup once:  npm install web-push
// Run:         node server.js
// Push alerts and screen-awake need HTTPS -> see README (cloudflared tunnel).

const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const webpush = require("web-push");

const PORT = 3000;

// ---- VAPID keys (identify your server to push services; made once, saved to vapid.json) ----
const VAPID_FILE = path.join(__dirname, "vapid.json");
let vapid;
if (fs.existsSync(VAPID_FILE)) vapid = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
else { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2)); }
webpush.setVapidDetails("mailto:test@example.com", vapid.publicKey, vapid.privateKey);

function lanIP() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === "IPv4" && !i.internal) return i.address;
  return "localhost";
}

// Public address = whatever address the staff screen was opened with (LAN IP or HTTPS tunnel)
function baseURL(req) {
  let host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  if (/^(localhost|127\.0\.0\.1)/.test(host)) host = `${lanIP()}:${PORT}`;
  let proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0];
  if (/https/.test(req.headers["cf-visitor"] || "")) proto = "https";
  return `${proto}://${host}`;
}

let nextNum = 1;
const tickets = {}; // id -> { id, num, name, status, clients:Set, subs:[] }
const staffClients = new Set();

function listData() {
  const now = Date.now();
  return Object.values(tickets).sort((a, b) => b.num - a.num).map((t) => ({
    id: t.id, num: t.num, name: t.name, status: t.status,
    online: t.clients.size > 0 || now - (t.lastSeen || 0) < 7000, push: t.subs.length > 0,
  }));
}
function staffUpdate() {
  const data = listData();
  for (const res of staffClients) res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendToTicket(id, msg) {
  const t = tickets[id];
  if (t) for (const res of t.clients) res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

async function pushToTicket(t) {
  const payload = JSON.stringify({
    title: `🔔 Order #${t.num} is ready!`,
    body: (t.name ? t.name + ", p" : "P") + "lease come to the counter.",
    url: `/t/${t.id}`, tag: `ticket-${t.id}`,
  });
  for (const sub of [...t.subs]) {
    try { await webpush.sendNotification(sub, payload, { TTL: 300, urgency: "high" }); }
    catch (e) {
      console.log(`  push failed for #${t.num}: ${e.statusCode || e.message}`);
      if (e.statusCode === 404 || e.statusCode === 410) t.subs = t.subs.filter((s) => s !== sub);
    }
  }
}

function sse(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": " + " ".repeat(2048) + "\n\n"); // padding so proxies/tunnels flush right away
  res.write(": connected\n\n");
}
setInterval(() => {
  for (const r of staffClients) r.write(": ping\n\n");
  for (const t of Object.values(tickets)) for (const r of t.clients) r.write(": ping\n\n");
}, 15000);

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e4) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}
const send = (res, type, body, code = 200) => { res.writeHead(code, { "Content-Type": type }); res.end(body); };
const html = (res, s) => send(res, "text/html; charset=utf-8", s);
const json = (res, o) => send(res, "application/json", JSON.stringify(o));

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const BASE = baseURL(req);
  let m;

  if (p === "/" || p === "/staff") return html(res, STAFF_HTML.replaceAll("__JOIN__", BASE + "/join"));
  if (p === "/qr") return html(res, POSTER_HTML.replaceAll("__JOIN__", BASE + "/join"));
  if (p === "/sw.js") { res.setHeader("Service-Worker-Allowed", "/"); return send(res, "application/javascript", SW_JS); }
  if (p === "/icon.svg") return send(res, "image/svg+xml", ICON_SVG);

  // Per-ticket manifest so "Add to Home Screen" on iPhone opens the right ticket
  if ((m = p.match(/^\/manifest(?:\/([a-f0-9]{12}))?\.json$/))) {
    const start = m[1] ? `/t/${m[1]}` : "/join";
    return send(res, "application/manifest+json", JSON.stringify({
      name: "Queue Buzzer", short_name: "Buzzer", start_url: start, scope: "/", display: "standalone",
      background_color: "#18181b", theme_color: "#18181b",
      icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
    }));
  }

  const page = (t) => CUSTOMER_HTML
    .replace("__TICKET__", t ? JSON.stringify({ id: t.id, num: t.num, name: t.name }) : "null")
    .replace("__VAPID__", vapid.publicKey)
    .replace("__MANIFEST__", t ? `/manifest/${t.id}.json` : "/manifest.json");

  if (p === "/join") return html(res, page(null));
  if ((m = p.match(/^\/t\/([a-f0-9]{12})$/))) return html(res, page(tickets[m[1]]));

  if (p === "/api/join" && req.method === "POST") {
    const body = await readBody(req);
    const name = String(body.name || "").trim().slice(0, 30);
    const id = crypto.randomBytes(6).toString("hex");
    const t = { id, num: nextNum++, name, status: "waiting", clients: new Set(), subs: [] };
    tickets[id] = t; staffUpdate();
    return json(res, { id: t.id, num: t.num, name: t.name });
  }

  // Phone sends its anonymous push address (no phone number, no account)
  if ((m = p.match(/^\/api\/subscribe\/([a-f0-9]{12})$/)) && req.method === "POST") {
    const t = tickets[m[1]]; const sub = await readBody(req);
    if (t && sub && typeof sub.endpoint === "string" && sub.keys) {
      t.subs = t.subs.filter((s) => s.endpoint !== sub.endpoint); t.subs.push(sub); staffUpdate();
    }
    return json(res, { ok: !!t });
  }

  if ((m = p.match(/^\/api\/(buzz|done|ack|remove)\/([a-f0-9]{12})$/)) && req.method === "POST") {
    const [, action, id] = m; const t = tickets[id];
    if (t) {
      if (action === "buzz") { t.status = "buzzing"; sendToTicket(id, { type: "buzz" }); pushToTicket(t); }
      if (action === "ack") t.status = "coming";
      if (action === "done") { t.status = "done"; sendToTicket(id, { type: "stop" }); }
      if (action === "remove") { sendToTicket(id, { type: "stop" }); delete tickets[id]; }
      staffUpdate();
    }
    return send(res, "text/plain", "ok");
  }

  // Polling endpoints (work through any tunnel/proxy)
  if (p === "/api/list") return json(res, listData());
  if ((m = p.match(/^\/api\/status\/([a-f0-9]{12})$/))) {
    const t = tickets[m[1]];
    if (!t) return json(res, { status: "gone" });
    t.lastSeen = Date.now();
    return json(res, { status: t.status });
  }

  if (p === "/events/staff") {
    sse(res); staffClients.add(res); staffUpdate();
    req.on("close", () => staffClients.delete(res)); return;
  }
  if ((m = p.match(/^\/events\/([a-f0-9]{12})$/))) {
    const t = tickets[m[1]];
    if (!t) return send(res, "text/plain", "gone", 404);
    sse(res); t.clients.add(res);
    if (t.status === "buzzing") res.write(`data: ${JSON.stringify({ type: "buzz" })}\n\n`);
    staffUpdate();
    req.on("close", () => { t.clients.delete(res); staffUpdate(); }); return;
  }

  send(res, "text/plain", "Not found", 404);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("\n  QR Buzzer running on port " + PORT);
  console.log(`  Wi-Fi test (no push):  http://${lanIP()}:${PORT}/staff`);
  console.log("  HTTPS test (push + screen-awake): run in another terminal:");
  console.log(`      cloudflared tunnel --url http://localhost:${PORT}`);
  console.log("    then open  https://<the-trycloudflare-address>/staff\n");
});

// ---------------- SERVICE WORKER (shows the lock-screen alert) ----------------
const SW_JS = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Your order is ready!', {
    body: d.body || 'Please come to the counter.',
    tag: d.tag, renotify: true, requireInteraction: true,
    vibrate: [500, 200, 500, 200, 800], icon: '/icon.svg', badge: '/icon.svg',
    data: { url: d.url || '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data.url;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.includes(url)) return c.focus();
    return clients.openWindow(url);
  }));
});`;

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="110" fill="#dc2626"/><text x="256" y="350" font-size="300" text-anchor="middle">🔔</text></svg>`;

// ---------------- STAFF PAGE ----------------
const STAFF_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Buzzer – Staff</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
  body{font-family:system-ui,sans-serif;margin:0;background:#f4f4f5;color:#18181b}
  header{background:#18181b;color:#fff;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
  h1{margin:0;font-size:20px}
  .wrap{display:grid;grid-template-columns:300px 1fr;gap:24px;padding:24px}
  @media(max-width:800px){.wrap{grid-template-columns:1fr}}
  .card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 3px #0001}
  button,a.btn{font:inherit;border:0;border-radius:10px;padding:10px 14px;cursor:pointer;font-weight:600;text-decoration:none;display:inline-block}
  #qr{display:flex;justify-content:center;margin:10px 0}
  .small{font-size:12px;color:#71717a;text-align:center;word-break:break-all}
  .warn{background:#fef3c7;color:#92400e;font-size:13px;padding:10px;border-radius:10px;margin-top:12px;text-align:left}
  table{width:100%;border-collapse:collapse}
  td,th{padding:12px 8px;border-bottom:1px solid #e4e4e7;text-align:left}
  th{font-size:12px;color:#71717a;text-transform:uppercase}
  .num{font-size:22px;font-weight:800}
  .name{font-weight:600}.id{font-size:11px;color:#a1a1aa;font-family:monospace}
  .buzz{background:#dc2626;color:#fff}.done{background:#e4e4e7}.rm{background:none;color:#a1a1aa}
  .pill{font-size:12px;padding:3px 8px;border-radius:99px;font-weight:600}
  .waiting{background:#fef3c7;color:#92400e}.buzzing{background:#fee2e2;color:#991b1b}
  .coming{background:#dbeafe;color:#1e40af}.done-p{background:#dcfce7;color:#166534}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
  .empty{color:#a1a1aa;text-align:center;padding:30px}
  tr.isdone{opacity:.45}
</style></head><body>
<header><h1>🔔 Queue Buzzer — Staff</h1><span id="count" style="font-size:14px;opacity:.8"></span></header>
<div class="wrap">
  <div class="card" style="text-align:center">
    <b>Customer QR</b>
    <div id="qr"></div>
    <div class="small">__JOIN__</div>
    <p><a class="btn" style="background:#2563eb;color:#fff" href="/qr" target="_blank">🖨 Open printable QR</a></p>
    <div class="warn" id="httpWarn" style="display:none">⚠️ Not on HTTPS: lock-screen alerts and screen-awake are off. Open this page through your cloudflared https address.</div>
  </div>
  <div class="card">
    <table><thead><tr><th>#</th><th>Customer</th><th>Phone</th><th>Status</th><th></th></tr></thead>
    <tbody id="list"><tr><td colspan="5" class="empty">Waiting for customers to scan…</td></tr></tbody></table>
  </div>
</div>
<script>
if (location.protocol !== 'https:') document.getElementById('httpWarn').style.display='block';
new QRCode(document.getElementById('qr'),{text:'__JOIN__',width:220,height:220});
let act=(a,id)=>fetch('/api/'+a+'/'+id,{method:'POST'});
const esc=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function poll(){ try{ const r=await fetch('/api/list',{cache:'no-store'}); render(await r.json()); }catch(e){} }
setInterval(poll,1500); poll();
function render(rows){
  document.getElementById('count').textContent=rows.filter(t=>t.status!=='done').length+' in queue';
  const el=document.getElementById('list');
  if(!rows.length){el.innerHTML='<tr><td colspan="5" class="empty">Waiting for customers to scan…</td></tr>';return;}
  el.innerHTML=rows.map(t=>{
    const open=t.status!=='done', q="\\'"+t.id+"\\'";
    return '<tr class="'+(open?'':'isdone')+'"><td class="num">#'+t.num+'</td>'+
      '<td><div class="name">'+(t.name?esc(t.name):'<i style="color:#a1a1aa">No name</i>')+'</div><div class="id">ID '+t.id+'</div></td>'+
      '<td><span class="dot" style="background:'+(t.online?'#22c55e':'#d4d4d8')+'"></span>'+(t.online?'Page open':'Page closed')+
        '<div class="id">'+(t.push?'🔔 lock-screen alerts on':'no lock-screen alerts')+'</div></td>'+
      '<td><span class="pill '+(t.status==='done'?'done-p':t.status)+'">'+t.status+'</span></td>'+
      '<td style="text-align:right;white-space:nowrap">'+
        (open?'<button class="buzz" onclick="act(\\'buzz\\','+q+')">🔔 Buzz</button> <button class="done" onclick="act(\\'done\\','+q+')">Done</button>':'')+
        ' <button class="rm" title="Remove" onclick="act(\\'remove\\','+q+')">✕</button></td></tr>';
  }).join('');
}
const _act=act; act=(a,id)=>_act(a,id).then(poll);
</script></body></html>`;

// ---------------- PRINTABLE QR POSTER ----------------
const POSTER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Scan to join the queue</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
  body{font-family:system-ui,sans-serif;text-align:center;padding:40px;color:#18181b}
  h1{font-size:48px;margin:0 0 8px}p{font-size:22px;color:#52525b;margin:0 0 30px}
  #qr{display:inline-block;padding:20px;border:4px solid #18181b;border-radius:20px}
  .steps{font-size:20px;margin-top:30px;line-height:1.8}
</style></head><body>
<h1>📱 Scan to join the queue</h1>
<p>We'll buzz your phone when your order is ready. No app, no sign-up.</p>
<div id="qr"></div>
<div class="steps">1. Scan &nbsp;•&nbsp; 2. Enter your name (optional) &nbsp;•&nbsp; 3. Allow notifications</div>
<script>new QRCode(document.getElementById('qr'),{text:'__JOIN__',width:360,height:360});</script>
</body></html>`;

// ---------------- CUSTOMER PAGE ----------------
const CUSTOMER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Queue</title>
<link rel="manifest" id="mf" href="__MANIFEST__">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Buzzer">
<meta name="theme-color" content="#18181b">
<style>
  html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:#18181b;color:#fff;padding:30px 20px 50px;box-sizing:border-box;min-height:100vh}
  .label{font-size:15px;opacity:.7;letter-spacing:2px;text-transform:uppercase}
  .num{font-size:110px;font-weight:900;line-height:1;margin:8px 0 6px}
  .who{font-size:22px;margin-bottom:14px;opacity:.9}
  #msg{font-size:19px;min-height:30px;max-width:360px}
  input{font:inherit;font-size:20px;padding:16px;border-radius:12px;border:0;width:100%;max-width:320px;box-sizing:border-box;text-align:center;margin:18px 0 0}
  button{font:inherit;font-size:20px;font-weight:700;border:0;border-radius:14px;padding:18px 28px;margin-top:16px;background:#2563eb;color:#fff;width:100%;max-width:320px}
  button.sec{background:#3f3f46;font-size:17px;padding:14px}
  .status{margin-top:18px;font-size:15px;line-height:1.9;background:#27272a;border-radius:12px;padding:10px 16px;text-align:left;max-width:320px;width:100%;box-sizing:border-box}
  .tip{margin-top:12px;font-size:14px;background:#1e3a8a;border-radius:12px;padding:12px;max-width:320px;text-align:left}
  #conn{position:fixed;bottom:12px;left:0;right:0;font-size:12px;opacity:.6}
  .hide{display:none!important}
  body.alarm{animation:flash .5s infinite}
  body.alarm button{background:#fff;color:#dc2626}
  @keyframes flash{0%,100%{background:#dc2626}50%{background:#facc15}}
  body.ready{background:#16a34a}
  body.alarm .status,body.alarm .tip,body.ready .status,body.ready .tip{display:none}
</style></head><body>

<div id="joinView">
  <div style="font-size:60px">🔔</div>
  <h1 style="margin:6px 0">Join the queue</h1>
  <div style="opacity:.75">We'll buzz this phone when your order is ready.<br>No app, no sign-up, no phone number.</div>
  <input id="name" maxlength="30" placeholder="Your name (optional)" autocomplete="given-name">
  <button id="joinBtn" onclick="join()">Join queue</button>
</div>

<div id="ticketView" class="hide">
  <div class="label">Your number</div>
  <div class="num" id="num"></div>
  <div class="who" id="who"></div>
  <div id="msg"></div>
  <button id="btn" class="hide"></button>
  <button id="pushBtn" class="sec hide" onclick="enablePush(true)">🔔 Alert me even if my phone is locked</button>
  <div class="status" id="status"></div>
  <div class="tip hide" id="iosTip">📱 <b>iPhone:</b> for alerts while your phone is locked, tap <b>Share ⬆︎</b> → <b>Add to Home Screen</b>, then open <b>Buzzer</b> from your home screen.</div>
  <div id="conn">Connecting…</div>
</div>

<script>
let ticket = __TICKET__;
const VAPID = '__VAPID__';
let ctx, beepTimer, es, wakeLock = null, soundOn = false, pushOn = false;
const $ = id => document.getElementById(id);
const secure = window.isSecureContext;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const pushSupported = secure && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

if (secure && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});

if (!ticket) { try { const s = localStorage.getItem('buzzerTicket'); if (s) location.replace('/t/'+s); } catch(e){} }

// ---------- sound (needs one tap) ----------
function unlockSound(){
  try { ctx = ctx || new (window.AudioContext||window.webkitAudioContext)(); ctx.resume(); tone(0.04); soundOn = true; } catch(e){}
  if (navigator.vibrate) navigator.vibrate(40);
}
function tone(dur){
  if(!ctx) return;
  const o=ctx.createOscillator(), g=ctx.createGain();
  o.type='square'; o.frequency.value=880; g.gain.value=0.3;
  o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime+dur);
}

// ---------- keep screen awake ----------
async function keepAwake(){
  if (!('wakeLock' in navigator) || document.visibilityState!=='visible') return renderStatus();
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', ()=>{ wakeLock=null; renderStatus(); }); }
  catch(e){ wakeLock = null; }
  renderStatus();
}
document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState==='visible' && ticket && !wakeLock) keepAwake(); });

// ---------- lock-screen push ----------
function b64ToBytes(s){ const p='='.repeat((4-s.length%4)%4); const b=atob((s+p).replace(/-/g,'+').replace(/_/g,'/')); return Uint8Array.from(b,c=>c.charCodeAt(0)); }
async function enablePush(fromTap, permPromise){
  if (!pushSupported || !ticket) return renderStatus();
  try {
    const perm = permPromise ? await permPromise : (fromTap ? await Notification.requestPermission() : Notification.permission);
    if (perm !== 'granted') return renderStatus();
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:b64ToBytes(VAPID) });
    await fetch('/api/subscribe/'+ticket.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub)});
    pushOn = true;
  } catch(e){ console.log('push error', e); }
  renderStatus();
}

function renderStatus(){
  if (!ticket) return;
  const perm = ('Notification' in window) ? Notification.permission : 'n/a';
  const row = (ok, text) => (ok ? '✅ ' : '⚪️ ') + text;
  $('status').innerHTML = [
    row(soundOn, 'Sound & on-screen alert'),
    row(pushOn, 'Lock-screen alert' + (!secure ? ' (needs https)' : perm==='denied' ? ' (blocked in settings)' : '')),
    row(!!wakeLock, 'Screen stays on' + (!secure ? ' (needs https)' : '')),
  ].join('<br>');
  $('pushBtn').classList.toggle('hide', pushOn || !pushSupported || perm==='denied');
  $('iosTip').classList.toggle('hide', !(isIOS && !standalone && secure));
}

// ---------- join ----------
async function join(){
  unlockSound();
  // ask for notification permission inside this same tap (browsers require a tap)
  const permP = (pushSupported && Notification.permission==='default') ? Notification.requestPermission() : null;
  $('joinBtn').disabled = true; $('joinBtn').textContent = 'Joining…';
  const r = await fetch('/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('name').value})});
  ticket = await r.json();
  try { localStorage.setItem('buzzerTicket', ticket.id); } catch(e){}
  history.replaceState(null,'','/t/'+ticket.id);
  $('mf').href = '/manifest/'+ticket.id+'.json';
  showTicket();
  armed();
  keepAwake();
  enablePush(false, permP);
}

function showTicket(){
  $('joinView').classList.add('hide'); $('ticketView').classList.remove('hide');
  $('num').textContent = ticket.num;
  $('who').textContent = ticket.name ? 'Hi, '+ticket.name+'!' : '';
  document.title = 'Order #'+ticket.num;
  connect(); renderStatus();
}
function armed(){ $('msg').textContent='You\\'re in the queue. Keep this page open.'; $('btn').classList.add('hide'); renderStatus(); }
function setBtn(text, fn){ const b=$('btn'); b.textContent=text; b.onclick=fn; b.classList.remove('hide'); }

// ---------- buzz ----------
function buzz(){
  document.body.className='alarm';
  $('msg').innerHTML='<b style="font-size:28px">YOUR ORDER IS READY!</b><br>Please come to the counter.';
  setBtn('OK, coming! 👍', ack); $('pushBtn').classList.add('hide');
  clearInterval(beepTimer);
  const ring=()=>{ tone(0.25); setTimeout(()=>tone(0.25),350); if(navigator.vibrate) navigator.vibrate([400,150,400]); };
  ring(); beepTimer=setInterval(ring,1200);
}
function stop(text, end){
  clearInterval(beepTimer); if(navigator.vibrate) navigator.vibrate(0);
  document.body.className='ready'; $('btn').classList.add('hide'); $('msg').textContent=text;
  if (end) {
    try{localStorage.removeItem('buzzerTicket')}catch(e){}
    if (wakeLock) wakeLock.release();
    setBtn('Join again', ()=>location.href='/join');
  }
}
function ack(){ state='coming'; stop('Thanks! See you at the counter.'); fetch('/api/ack/'+ticket.id,{method:'POST'}); }

let state = null, pollTimer;
function connect(){
  const check = async () => {
    try {
      const r = await fetch('/api/status/'+ticket.id, {cache:'no-store'});
      const d = await r.json();
      $('conn').textContent = '● Connected';
      if (d.status !== state) {
        const prev = state; state = d.status;
        if (d.status === 'buzzing') buzz();
        else if (d.status === 'done' || d.status === 'gone') { clearInterval(pollTimer); stop('Order collected. Thank you!', true); }
        else if (prev === 'buzzing' && d.status === 'waiting') armed();
      }
    } catch(e) { $('conn').textContent = 'Reconnecting…'; }
  };
  check(); pollTimer = setInterval(check, 1500);
}

// Re-opened ticket (refresh, rescan, or opened from iPhone home screen)
if (ticket) {
  showTicket();
  $('msg').textContent='Tap below to turn your buzzer back on.';
  setBtn('🔔 Turn on buzzer', ()=>{ unlockSound(); armed(); keepAwake(); enablePush(true); });
  if (pushSupported && Notification.permission==='granted') enablePush(false);
} else if (location.pathname.startsWith('/t/')) {
  try{localStorage.removeItem('buzzerTicket')}catch(e){}
  history.replaceState(null,'','/join');
}
</script></body></html>`;
