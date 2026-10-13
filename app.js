/* =====================================================================
   Bulloterie — Positionnement par thématique
   N'EPS numérique — Quentin Delisle
   PWA hors-ligne : données stockées sur l'appareil (localStorage),
   échanges entre l'appareil administrateur et les appareils participants par QR codes
   (même système que l'appli Biathlon : base45 + compression, séries de QR, lecteur natif / ZXing / jsQR).
   - Administrateur : salles, thématiques, participants (numéro ↔ nom), QR de la séance,
     récupération des QR des participants, tableau en direct (glisser-déposer), synthèse, export.
   - Participant : scanne la séance, entre son numéro, fait glisser sa bulle
     (Inquiet · Débutant · Confirmé · Expert) pour chaque thématique, puis affiche son QR.
   ===================================================================== */
'use strict';

const APP_VERSION = '1.0.0';
const STORE_KEY = 'neps_bulloterie_v1';
const QR_PREFIX = 'BU';
const QR_CHUNK = 440;            // caractères base45 par QR (comme Biathlon)

const LV = [
  { k:0, n:'Non positionné', e:'⚪', c:'#8A94A6', l:'#EEF1F6' },
  { k:1, n:'Inquiet',  e:'😟', c:'#E8403B', l:'#FFE7E5' },
  { k:2, n:'Débutant', e:'🌱', c:'#F08A00', l:'#FFF3E2' },
  { k:3, n:'Confirmé', e:'👍', c:'#0088E8', l:'#E3F3FD' },
  { k:4, n:'Expert',   e:'🏆', c:'#3A9A1E', l:'#E7F5DF' },
];

/* ---------------------------------------------------------------------
   Utilitaires
   --------------------------------------------------------------------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const now = () => Date.now();
function rnd(n){ const a='abcdefghijkmnpqrstuvwxyz23456789'; let s=''; for(let i=0;i<n;i++) s+=a[Math.floor(Math.random()*a.length)]; return s; }
const normNum = v => { const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10); return isNaN(n) || n <= 0 ? null : n; };
function toast(msg, ms=2200){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'), ms); }
const timeTxt = ts => new Date(ts).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });

function modal(html, {wide}={}){
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal" ${wide?'style="max-width:760px"':''}>${html}</div></div>`;
  const bg = root.firstElementChild;
  bg.addEventListener('click', e => { if (e.target === bg) closeModal(); });
  return bg.firstElementChild;
}
function closeModal(){ $('#modal-root').innerHTML=''; afterDomChange(); }
function confirmBox(title, text, okLabel='Valider', danger=false){
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2><p>${text}</p>
      <div class="btn-row spread"><button class="btn ghost" data-r="0">Annuler</button>
      <button class="btn ${danger?'red':'primary'}" data-r="1">${esc(okLabel)}</button></div>`);
    m.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { closeModal(); res(b.dataset.r==='1'); });
  });
}
function promptBox(title, label, value=''){
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2><label class="lbl">${esc(label)}</label>
      <input class="inp" id="pb-in" value="${esc(value)}">
      <div class="btn-row spread"><button class="btn ghost" data-r="0">Annuler</button><button class="btn primary" data-r="1">Valider</button></div>`);
    const inp = m.querySelector('#pb-in'); setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const done = ok => { const v = inp.value.trim(); closeModal(); res(ok ? v : null); };
    inp.onkeydown = e => { if (e.key === 'Enter') done(true); };
    m.querySelectorAll('[data-r]').forEach(b => b.onclick = () => done(b.dataset.r === '1'));
  });
}

/* ---------------------------------------------------------------------
   État
   ROOT = { deviceId, pin, role,
            salles:{ id:{ id, title, themes:[{id,t}], people:[{n,name}], resp:{ n:{ thId:{lv,ts} } }, log:[], check } },  ← administrateur
            activeP,
            recv:{ id:{ id, title, themes:[{id,t}], nums:[], at } }, activeE,                                          ← participant
            mine:{ salleId:{ n:{ thId:{lv,ts} } } }, cur:{ salleId:n } }
   --------------------------------------------------------------------- */
function normRoot(r){
  r = r && typeof r === 'object' ? r : {};
  r.deviceId = r.deviceId || rnd(4).toUpperCase();
  r.pin = r.pin || '0000'; r.role = r.role || null;
  r.salles = r.salles || {}; r.recv = r.recv || {}; r.mine = r.mine || {}; r.cur = r.cur || {};
  r.disp = r.disp || 'name';
  Object.values(r.salles).forEach(normSalle);
  return r;
}
function normSalle(s){ s.themes = s.themes || []; s.people = s.people || []; s.resp = s.resp || {}; s.log = s.log || []; if (s.check == null) s.check = true; return s; }
function newSalle(title){ return normSalle({ id: rnd(4), title: title || 'Nouvelle salle', created: now() }); }
function load(){ try { return normRoot(JSON.parse(localStorage.getItem(STORE_KEY))); } catch(e){ return normRoot({}); } }
let ROOT = load();
function save(){ try { localStorage.setItem(STORE_KEY, JSON.stringify(ROOT)); } catch(e){ toast('⚠️ Enregistrement impossible sur cet appareil'); } }

const SP = () => ROOT.salles[ROOT.activeP] || null;      // salle active (administrateur)
const SE = () => ROOT.recv[ROOT.activeE] || null;        // séance reçue active (participant)
const curNum = () => SE() ? (ROOT.cur[SE().id] || null) : null;
const personOf = (S, n) => S.people.find(p => p.n === n);
const nameOf = (S, n) => { const p = personOf(S, n); return p && p.name ? p.name : `N° ${n}`; };
const lvOf = (S, n, th) => S.resp[n]?.[th]?.lv || 0;
/* Tous les numéros connus d'une salle : participants inscrits + numéros reçus non attribués */
function allNums(S){
  const set = new Set(S.people.map(p => p.n));
  Object.keys(S.resp).forEach(n => { if (Object.values(S.resp[n]).some(r => r.lv)) set.add(+n); });
  return [...set].sort((a,b) => a-b);
}
const unknownNums = S => allNums(S).filter(n => !personOf(S, n));
const doneCount = (S, n) => S.themes.filter(t => lvOf(S, n, t.id)).length;

/* ---------------------------------------------------------------------
   Échanges : paquets, compression, QR codes (repris de Biathlon)
   T = séance (administrateur → participants) · R = positionnements (participant → administrateur)
   --------------------------------------------------------------------- */
function buildT(S){
  return { k:'T', s:S.id, t:S.title, h:S.themes.map(x => [x.id, x.t]), n: S.check ? S.people.map(p => p.n) : [] };
}
function buildR(sid){
  const E = ROOT.recv[sid], M = ROOT.mine[sid] || {};
  const h = E.themes.map(x => x.id);
  let T = Infinity;
  Object.values(M).forEach(byT => Object.values(byT).forEach(r => { if (r.ts) T = Math.min(T, Math.floor(r.ts/1000)); }));
  if (!isFinite(T)) T = Math.floor(now()/1000);
  const r = Object.entries(M).filter(([, byT]) => h.some(id => byT[id])).map(([n, byT]) =>
    [ +n, h.map(id => byT[id]?.lv || 0).join(''), h.map(id => byT[id] ? Math.floor(byT[id].ts/1000) - T : -1) ]);
  return { k:'R', s:sid, d:ROOT.deviceId, T, h, r };
}
function applyT(p){
  if (!p.s || !Array.isArray(p.h)) throw new Error('QR de séance incomplet');
  ROOT.recv[p.s] = { id:p.s, title:p.t || 'Séance', themes:p.h.map(([id, t]) => ({ id, t })), nums:p.n || [], at:now() };
  ROOT.activeE = p.s;
  const n = ROOT.cur[p.s];
  if (n && p.n && p.n.length && !p.n.includes(n)) delete ROOT.cur[p.s];
  save();
}
function applyR(p){
  const S = ROOT.salles[p.s];
  if (!S) throw new Error('Ce QR vient d\'une autre salle (inconnue sur cet appareil)');
  let changed = 0; const people = new Set(), fresh = [];
  (p.r || []).forEach(([num, lvs, tss]) => {
    num = normNum(num); if (!num) return;
    people.add(num);
    p.h.forEach((tid, i) => {
      if (tss[i] == null || tss[i] < 0) return;
      if (!S.themes.some(t => t.id === tid)) return;              // thématique supprimée depuis
      const ts = (p.T + tss[i]) * 1000, lv = Math.max(0, Math.min(4, +lvs[i] || 0));
      const R = S.resp[num] = S.resp[num] || {}, cur = R[tid];
      if (!cur || ts > cur.ts) { if (!cur || cur.lv !== lv) { changed++; fresh.push(num + '|' + tid); } R[tid] = { lv, ts }; }
    });
  });
  S.log.unshift({ d:p.d, at:now(), np:people.size, n:changed, nums:[...people] }); S.log = S.log.slice(0, 40);
  UI.fresh = { set:new Set(fresh), at:now() };
  if (ROOT.activeP !== S.id) ROOT.activeP = S.id;
  save();
  return { S, np:people.size, changed, nums:[...people] };
}

/* Base45 : alphabet du mode « alphanumérique » des QR codes */
const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
function b45enc(u8){ let s = '';
  for (let i = 0; i < u8.length; i += 2) {
    if (i + 1 < u8.length) { let x = u8[i]*256 + u8[i+1]; const c = x % 45; x = (x-c)/45; const d = x % 45; const e = (x-d)/45; s += B45[c] + B45[d] + B45[e]; }
    else { const x = u8[i], c = x % 45, d = (x-c)/45; s += B45[c] + B45[d]; }
  } return s; }
function b45dec(s){ const out = [];
  for (let i = 0; i < s.length; i += 3) {
    const c = B45.indexOf(s[i]), d = B45.indexOf(s[i+1]);
    if (c < 0 || d < 0) throw new Error('QR abîmé');
    if (i + 2 < s.length) { const x = c + d*45 + B45.indexOf(s[i+2])*2025; out.push(x >> 8, x & 255); }
    else out.push(c + d*45);
  } return new Uint8Array(out); }
async function streamBytes(u8, ts){ const st = new Blob([u8]).stream().pipeThrough(ts); return new Uint8Array(await new Response(st).arrayBuffer()); }
async function encodePacket(obj){
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (window.CompressionStream) {
    try { const z = await streamBytes(raw, new CompressionStream('deflate-raw')); if (z.length < raw.length) return 'Z' + b45enc(z); } catch(e){}
  }
  return 'J' + b45enc(raw);
}
async function decodePacket(str){
  const flag = str[0]; let raw = b45dec(str.slice(1));
  if (flag === 'Z') {
    if (!window.DecompressionStream) throw new Error('Appareil trop ancien pour décompresser');
    raw = await streamBytes(raw, new DecompressionStream('deflate-raw'));
  } else if (flag !== 'J') throw new Error('Format inconnu');
  return JSON.parse(new TextDecoder().decode(raw));
}
function chunkQR(payload, type, max=QR_CHUNK){
  const id = rnd(3).toUpperCase(), parts = [];
  const n = Math.max(1, Math.ceil(payload.length / max));
  const per = Math.ceil(payload.length / n);          // morceaux égaux = QR les moins denses possible
  for (let i = 0; i < n; i++) parts.push(`${QR_PREFIX}:${type}:${id}:${i+1}:${n}:` + payload.slice(i*per, (i+1)*per));
  return parts;
}
function qrDataURL(text){
  const qr = qrcode(0, 'L'); qr.addData(text, 'Alphanumeric'); qr.make();
  return qr.createDataURL(10, 40);   // marge blanche = 4 modules (zone de silence obligatoire)
}
/* Lecture d'un morceau scanné : « BU:T:ID:i:n:données » */
function parsePart(txt){
  if (!txt || !txt.startsWith(QR_PREFIX + ':')) return null;
  const f = txt.split(':');
  if (f.length < 6) return null;
  return { type:f[1], id:f[2], i:+f[3], n:+f[4], data:f.slice(5).join(':') };
}

/* Affichage d'une série de QR (défilement automatique, 1 QR par seconde) */
let qrTimer = null;
function showQRSeries(parts, container, title){
  let i = 0, auto = parts.length > 1;
  const imgs = parts.map(qrDataURL);
  const draw = () => {
    container.innerHTML = `<div class="qr-box">
      ${title?`<h2 class="center">${title}</h2>`:''}
      <img src="${imgs[i]}" alt="QR code ${i+1}/${parts.length}">
      <div class="qr-part">${parts.length>1?`QR ${i+1} / ${parts.length}`:'QR unique'}</div>
      ${parts.length>1?`<div class="qr-nums">${parts.map((_,k)=>`<button class="${k===i?'on':''}" data-q="${k}">${k+1}</button>`).join('')}</div>
        <div class="btn-row" style="justify-content:center"><button class="btn" data-q="prev">←</button>
        <button class="btn ${auto?'orange':''}" data-q="auto">${auto?'⏸ Pause':'▶ Défilement auto'}</button>
        <button class="btn" data-q="next">→</button></div>`:''}
    </div>`;
    container.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
      const q = b.dataset.q;
      if (q === 'auto') auto = !auto;
      else if (q === 'prev') { auto = false; i = (i - 1 + parts.length) % parts.length; }
      else if (q === 'next') { auto = false; i = (i + 1) % parts.length; }
      else { auto = false; i = +q; }
      draw();
    });
  };
  clearInterval(qrTimer);
  qrTimer = setInterval(() => { if (!document.body.contains(container)) return clearInterval(qrTimer); if (auto) { i = (i+1) % parts.length; draw(); } }, 1000);
  draw();
}
/* QR d'accès à l'application (adresse de cette page) */
const appURL = () => location.href.split('#')[0].split('?')[0].replace(/index\.html$/, '');
function appQRImg(size=6){ const qr = qrcode(0, 'M'); qr.addData(appURL()); qr.make(); return qr.createDataURL(size, 24); }
function appQRCard(){
  if (!/^https?:/.test(location.protocol)) return '';
  return `<div class="card compact app-qr"><img src="${appQRImg(5)}" alt="QR d'accès à l'application" data-action="appQR">
    <div><b>📲 Accès à l'application</b><div class="muted">Les participants scannent ce QR avec l'appareil photo pour ouvrir l'appli (puis « Ajouter à l'écran d'accueil »).</div>
      <div class="app-url">${esc(appURL())}</div><button class="btn small" data-action="appQR">🔍 Agrandir</button></div></div>`;
}

/* ---------------------------------------------------------------------
   Scanner : caméra (détecteur natif si disponible, sinon ZXing / jsQR)
   + secours « photo du QR » — repris de Biathlon
   --------------------------------------------------------------------- */
let scan = null;
function stopScan(){
  if (!scan) return;
  scan.stopped = true;
  clearTimeout(scan.timer);
  if (scan.stream) scan.stream.getTracks().forEach(t => t.stop());
  scan = null;
}
/* Après chaque changement d'écran : la caméra s'arrête si son cadre a disparu */
function afterDomChange(){ if (scan && !document.body.contains(scan.container)) stopScan(); }
let nativeDetector, scanCamIdx = 0, scanCamId = null;
async function getNativeDetector(){
  if (nativeDetector !== undefined) return nativeDetector;
  nativeDetector = null;
  try { if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) nativeDetector = new BarcodeDetector({ formats:['qr_code'] }); } catch(e){}
  return nativeDetector;
}
const SCAN_SCALES = [0.4, 0.3, 0.5, 0.24, 0.62, 0.35, 0.8, 0.45];
function grabGray(ctx, cv, src, sx, sy, sw, sh, maxSide){
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw*k), h = Math.round(sh*k);
  cv.width = w; cv.height = h; ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, g = new Float32Array(w*h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = d[j]*0.3 + d[j+1]*0.59 + d[j+2]*0.11;
  return { g, w, h };
}
function boxDown(G, f){
  const { g, w, h } = G;
  if (f >= 0.999) return G;
  const nw = Math.max(1, Math.round(w*f)), nh = Math.max(1, Math.round(h*f));
  const o = new Float32Array(nw*nh), c = new Float32Array(nw*nh);
  for (let y = 0; y < h; y++) { const yy = Math.min(nh-1, (y*f)|0), row = yy*nw;
    for (let x = 0; x < w; x++) { const i = row + Math.min(nw-1, (x*f)|0); o[i] += g[y*w+x]; c[i]++; } }
  for (let i = 0; i < o.length; i++) o[i] /= c[i] || 1;
  return { g:o, w:nw, h:nh };
}
function jsqrGray(G, both){
  if (!window.jsQR) return null;
  const { g, w, h } = G, d = new Uint8ClampedArray(w*h*4);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) { d[j] = d[j+1] = d[j+2] = g[i]; d[j+3] = 255; }
  const c = jsQR(d, w, h, { inversionAttempts: both ? 'attemptBoth' : 'dontInvert' });
  return c && c.data ? c.data : null;
}
let zxReady = false;
try {
  if (window.ZXingWASM) ZXingWASM.prepareZXingModule({ overrides:{ locateFile:(path, prefix) => path.endsWith('.wasm') ? new URL('lib/' + path, document.baseURI).href : prefix + path }, fireImmediately:true })
    .then(() => { zxReady = true; }).catch(e => console.warn('ZXing', e));
} catch(e){}
async function zxRead(imgData, hard=true){
  if (!zxReady) return null;
  try { const r = await ZXingWASM.readBarcodes(imgData, { formats:['QRCode'], tryHarder:hard, maxNumberOfSymbols:1 });
    const ok = r.find(x => x.isValid && x.text); return ok ? ok.text : null; } catch(e){ return null; }
}
async function decodeImageSource(src, sw, sh, cv, ctx, frame, all=false){
  const det = await getNativeDetector();
  if (det) { try { const r = await det.detect(src); if (r && r.length) return r.map(x => x.rawValue); } catch(e){} }
  const side = Math.min(sw, sh) * 0.92, sx = (sw - side)/2, sy = (sh - side)/2;
  if (zxReady) {
    const k = Math.min(1, (all ? 1000 : 800) / side), w = Math.round(side*k);
    cv.width = w; cv.height = w; ctx.drawImage(src, sx, sy, side, side, 0, 0, w, w);
    let t = await zxRead(ctx.getImageData(0, 0, w, w), all || frame % 3 !== 1);
    if (t) return [t];
    if (all || frame % 3 === 2) {
      const k2 = Math.min(1, 1280 / Math.max(sw, sh)), w2 = Math.round(sw*k2), h2 = Math.round(sh*k2);
      cv.width = w2; cv.height = h2; ctx.drawImage(src, 0, 0, sw, sh, 0, 0, w2, h2);
      t = await zxRead(ctx.getImageData(0, 0, w2, h2));
      if (t) return [t];
    }
    if (!all && frame % 2 === 0) return [];
  }
  const G = grabGray(ctx, cv, src, sx, sy, side, side, 1100);
  const scales = all ? SCAN_SCALES : [SCAN_SCALES[frame % SCAN_SCALES.length], SCAN_SCALES[(frame+3) % SCAN_SCALES.length]];
  for (const f of scales) { const t = jsqrGray(boxDown(G, f * side / G.w), all || frame % 5 === 4); if (t) return [t]; }
  if (all || frame % 4 === 3) {
    const F = grabGray(ctx, cv, src, 0, 0, sw, sh, 1100);
    for (const f of (all ? [0.35, 0.5, 0.7] : [0.5])) { const t = jsqrGray(boxDown(F, f), all); if (t) return [t]; }
  }
  return [];
}
/* expectType : 'T' (participants) ou 'R' (administrateur) · onDone(paquet) → 'continue' pour garder la caméra allumée */
async function startScan(container, expectType, onDone, compact=false){
  stopScan();
  container.innerHTML = `<div class="scan-wrap ${compact?'compact':''}"><video playsinline webkit-playsinline muted autoplay></video><div class="scan-frame"></div></div>
    <div class="scan-under">
      <div class="scan-parts"></div>
      <p class="center scan-msg">Démarrage de la caméra…</p>
      <div class="btn-row" style="justify-content:center"><button class="btn small" data-cam>🔄 Caméra</button><label class="btn small orange">📷 Photo du QR<input type="file" accept="image/*" capture="environment" hidden class="scan-photo"></label></div>
      ${compact ? '' : '<p class="center scan-diag"></p>'}</div>`;
  const video = container.querySelector('video'), msg = container.querySelector('.scan-msg'), partsEl = container.querySelector('.scan-parts');
  const me = scan = { stopped:false, parts:{}, id:null, n:0, frame:0, container };
  const cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently:true });
  const showParts = () => { const got = Object.keys(me.parts).length, pc = me.n ? Math.round(got / me.n * 100) : 0;
    partsEl.innerHTML = me.n > 1 ? `<div class="scan-prog"><div class="scan-bar" style="width:${pc}%"></div><span>${pc} %</span></div>` : ''; };
  let finished = false;
  const handle = async texts => {
    for (const txt of texts) {
      const pt = parsePart(txt);
      if (!pt) { msg.textContent = 'QR non reconnu (ce n\'est pas un QR Bulloterie).'; continue; }
      if (expectType && pt.type !== expectType) { msg.textContent = pt.type === 'T' ? 'Ce QR est destiné aux participants (QR de la séance).' : 'Ce QR est destiné à l\'administrateur de la salle.'; continue; }
      if (pt.id === me.doneId) continue;            // QR déjà traité (encore devant la caméra)
      if (me.id !== pt.id) { me.id = pt.id; me.parts = {}; me.n = pt.n; }
      if (!me.parts[pt.i]) { me.parts[pt.i] = pt.data; if (navigator.vibrate) navigator.vibrate(40); }
      const got = Object.keys(me.parts).length;
      showParts();
      msg.textContent = me.n > 1 ? (got < me.n ? `Import : ${Math.round(got / me.n * 100)} % · laissez défiler les QR devant la caméra` : 'Import : 100 %') : 'QR reçu !';
      if (got === me.n && !finished) {
        finished = true;
        const payload = Array.from({length: me.n}, (_, k) => me.parts[k+1]).join('');
        me.doneId = me.id; me.id = null; me.parts = {};
        let r;
        try { r = await onDone(await decodePacket(payload)); }
        catch(e) { console.warn(e); toast('⚠️ ' + e.message, 3500); r = 'continue'; }
        if (r === 'continue' && scan === me && !me.stopped) {
          finished = false; showParts(); msg.textContent = '✓ Reçu · QR suivant…'; me.timer = setTimeout(tick, 400);
        } else if (scan === me) stopScan();
        return;
      }
    }
  };
  container.querySelector('.scan-photo').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    msg.textContent = 'Lecture de la photo…';
    try {
      const bmp = await createImageBitmap(f);
      const pcv = document.createElement('canvas'), pctx = pcv.getContext('2d', { willReadFrequently:true });
      const r = await decodeImageSource(bmp, bmp.width, bmp.height, pcv, pctx, 0, true);
      if (r.length) await handle(r); else msg.textContent = '⚠️ QR non trouvé sur la photo : recommencez en cadrant le QR bien net, en entier.';
    } catch(err) { msg.textContent = '⚠️ Photo illisible'; }
  });
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg.innerHTML = '⚠️ Caméra indisponible : utilisez 📷 Photo du QR.'; return; }
  const diag = container.querySelector('.scan-diag');
  container.querySelector('[data-cam]').onclick = async () => {
    try { const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      if (cams.length < 2) return toast('Une seule caméra');
      scanCamIdx = (scanCamIdx + 1) % cams.length; scanCamId = cams[scanCamIdx].deviceId;
      startScan(container, expectType, onDone, compact); } catch(e){}
  };
  const attempts = scanCamId
    ? [{ deviceId:{ exact: scanCamId } }]
    : [{ facingMode:'environment' }, { facingMode:{ ideal:'environment' }, width:{ ideal:1280 }, height:{ ideal:720 } }, true];
  let lastErr = null;
  for (const vc of attempts) {
    try { me.stream = await navigator.mediaDevices.getUserMedia({ video: vc, audio:false }); break; }
    catch(e) { lastErr = e; }
  }
  if (!me.stream) {
    const n = lastErr && lastErr.name;
    msg.innerHTML = n === 'NotAllowedError' ? '⚠️ Caméra refusée : autorisez la caméra pour ce site dans les réglages, ou utilisez 📷 Photo du QR.'
      : '⚠️ Caméra impossible à ouvrir (' + esc(n || 'erreur') + ') : utilisez 📷 Photo du QR.';
    return;
  }
  if (me.stopped) { me.stream.getTracks().forEach(t=>t.stop()); return; }
  const track = me.stream.getVideoTracks()[0];
  try { await track.applyConstraints({ advanced:[{ focusMode:'continuous' }] }); } catch(e){}
  video.muted = true; video.autoplay = true;
  video.srcObject = me.stream;
  const playIt = () => video.play().catch(()=>{});
  video.onloadedmetadata = playIt; playIt();
  msg.textContent = 'Visez le QR code…';
  const reader = () => nativeDetector ? 'lecteur natif' : zxReady ? 'lecteur ZXing' : 'lecteur jsQR';
  const t0 = Date.now(); let lastDiag = 0, decodes = 0, dark = 0, switched = false;
  const probe = document.createElement('canvas'), pctx = probe.getContext('2d', { willReadFrequently:true }); probe.width = 32; probe.height = 18;
  const tick = async () => {
    if (me.stopped || finished) return;
    if (!document.body.contains(container)) return stopScan();
    const t = Date.now();
    if (video.readyState >= 2 && video.videoWidth) {
      me.frame++;
      if (me.frame % 10 === 1) {                     // image noire ? → autre caméra
        pctx.drawImage(video, 0, 0, 32, 18); const d = pctx.getImageData(0, 0, 32, 18).data; let m = 0;
        for (let i = 0; i < d.length; i += 4) m += d[i] + d[i+1] + d[i+2]; m /= (d.length/4*3);
        dark = m < 6 ? dark + 1 : 0;
        if (dark >= 4 && !switched) { switched = true; toast('Image noire : autre caméra…');
          try { const cams = (await navigator.mediaDevices.enumerateDevices()).filter(x => x.kind === 'videoinput');
            if (cams.length > 1) { const cur = track.getSettings().deviceId; const i = cams.findIndex(c => c.deviceId === cur);
              scanCamIdx = (i + 1) % cams.length; scanCamId = cams[scanCamIdx].deviceId; return startScan(container, expectType, onDone, compact); } } catch(e){}
          msg.textContent = '⚠️ Image noire : touchez 🔄 Caméra ou utilisez 📷 Photo du QR.'; }
      }
      try { const r = await decodeImageSource(video, video.videoWidth, video.videoHeight, cv, ctx, me.frame); decodes++; if (r.length) await handle(r); } catch(e){ console.warn(e); }
    } else if (t - t0 > 4000 && me.frame === 0) {
      msg.textContent = '⚠️ La caméra ne renvoie pas d\'image : touchez 🔄 Caméra ou utilisez 📷 Photo du QR.';
      playIt();
    }
    if (diag && t - lastDiag > 1000) {
      const el = (t - (lastDiag || t0)) / 1000;
      diag.textContent = `Caméra ${video.videoWidth}×${video.videoHeight} · ${Math.round(decodes/el)} analyses/s · ${reader()} · v${APP_VERSION}`;
      lastDiag = t; decodes = 0;
    }
    if (!me.stopped && !finished) me.timer = setTimeout(tick, 60);
  };
  tick();
}

/* Fichiers (secours : AirDrop / Partage à proximité) */
async function downloadFile(content, name, type='application/json'){
  const blob = new Blob([content], { type });
  try {
    const file = new File([blob], name, { type });
    if (type === 'application/json' && navigator.canShare && navigator.canShare({ files:[file] })) { await navigator.share({ files:[file], title:name }); return; }
  } catch(e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const fileSafe = s => String(s || 'salle').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_').slice(0, 40);

/* ---------------------------------------------------------------------
   Rendu général
   --------------------------------------------------------------------- */
const UI = { view:'home', tab:'salle', th:0, sort:'num', fresh:null, profUnlocked:false, dock:false, proj:false, digits:'', lastDrop:null };
function setTop(main, sub, right=''){ $('#tb-main').textContent = main; $('#tb-sub').textContent = sub || ''; $('#tb-right').innerHTML = right; }
function go(view){ UI.view = view; render(); window.scrollTo(0, 0); }
function render(){
  const m = $('#main');
  document.body.classList.toggle('proj', !!(ROOT.role === 'prof' && UI.profUnlocked && UI.tab === 'board' && UI.proj));
  $('#tabs').innerHTML = '';
  if (!ROOT.role) { setTop('Bulloterie', 'Positionnement par thématique'); m.innerHTML = vRole(); }
  else if (ROOT.role === 'prof') {
    if (!UI.profUnlocked) {
      setTop('Bulloterie', 'Espace administrateur', `<button class="btn small light" data-action="setRole" data-r="eleve">🙋 Participant</button>`);
      m.innerHTML = `<div class="hero"><img class="hero-logo" src="icons/icon-512.png" alt=""><h1>Espace administrateur</h1>
        <p class="muted">Les noms des participants sont protégés par le code administrateur.</p>
        <button class="btn primary big" data-action="unlock">🔒 Entrer le code</button></div>`;
    } else renderProf(m);
  }
  else renderEleve(m);
  if (UI.dock && !(ROOT.role === 'prof' && UI.profUnlocked && UI.tab === 'board')) closeDock();
  afterDomChange();
  afterRender();
}
function afterRender(){
  if (ROOT.role === 'eleve') {
    if (UI.view === 'scanT') {
      const area = $('#scan-area');
      if (area) startScan(area, 'T', async p => {
        applyT(p); toast(`✓ Séance « ${p.t} » reçue · ${p.h.length} thématique(s)`, 3000);
        go(curNum() ? 'pos' : 'num'); return 'stop';
      });
    }
    if (UI.view === 'send') (async () => {
      const E = SE(); if (!E) return;
      const payload = await encodePacket(buildR(E.id));
      const area = $('#qr-area'); if (area && UI.view === 'send') showQRSeries(chunkQR(payload, 'R', 260), area, '');
    })();
  }
  if (ROOT.role === 'prof' && UI.profUnlocked) {
    const S = SP();
    if (UI.tab === 'qr' && S && S.themes.length) (async () => {
      const payload = await encodePacket(buildT(S));
      const area = $('#qr-seance'); if (area && UI.tab === 'qr') showQRSeries(chunkQR(payload, 'T'), area, esc(S.title));
    })();
    if (UI.tab === 'recup' && S) { const area = $('#recup-scan'); if (area && (!scan || scan.container !== area)) startScan(area, 'R', onRecv); }
    if (UI.tab === 'board' && UI.dock) openDock();
  }
}
function onRecv(p){
  const r = applyR(p);
  toast(`✓ ${r.np} participant(s) reçu(s) · ${r.changed} changement(s)`, 2500);
  refreshLive();
  return 'continue';
}
function refreshLive(){
  if (UI.tab === 'recup') { const s = $('#recup-side'); if (s) s.innerHTML = recupSide(); }
  if (UI.tab === 'board') { const b = $('#board-area'); if (b) b.innerHTML = boardArea(); }
}
/* Réception « dans le coin » pendant l'affichage du tableau (projection en direct) */
function openDock(){
  const root = $('#dock-root');
  if (!root.firstElementChild) root.innerHTML = `<div class="dock-scan"><div class="dock-h"><b>📷 Réception des QR</b><button class="x" data-action="dockOff" aria-label="Fermer">✕</button></div><div id="dock-cam"></div></div>`;
  const area = $('#dock-cam');
  if (!scan || scan.container !== area) startScan(area, 'R', onRecv, true);
}
function closeDock(){ UI.dock = false; $('#dock-root').innerHTML = ''; afterDomChange(); }

const lvChip = (k, small) => `<span class="lvchip ${small?'sm':''}" style="--c:${LV[k].c};--l:${LV[k].l}">${LV[k].e} ${LV[k].n}</span>`;
const legend = () => `<div class="legend">${[1,2,3,4].map(k => lvChip(k)).join('')}</div>`;

function vRole(){
  return `<div class="hero"><img class="hero-logo" src="icons/icon-512.png" alt="">
    <h1>Bulloterie</h1><p class="muted">Chacun fait glisser sa bulle pour se positionner sur chaque thématique.</p>${legend()}</div>
    <div class="role-grid">
      <button class="home-btn" data-action="setRole" data-r="eleve"><span class="ico">🙋</span>Je suis participant<small>Scanner la séance · me positionner · montrer mon QR</small></button>
      <button class="home-btn prof" data-action="setRole" data-r="prof"><span class="ico">🧑‍🏫</span>Administrateur de la salle<small>Thématiques · participants · QR · tableau en direct</small></button>
    </div>`;
}

/* ---------------------------------------------------------------------
   Participant
   --------------------------------------------------------------------- */
function renderEleve(m){
  const E = SE(), lock = `<button class="btn small light" data-action="toProf" aria-label="Administrateur">🔒</button>`;
  const v = UI.view;
  if (v === 'scanT') { setTop('Scanner la séance', 'QR affiché par l\'administrateur', lock);
    m.innerHTML = `<div class="card strong center"><b class="big-txt">📷 Vise le QR de la séance</b></div><div id="scan-area"></div>
      <div class="btn-row" style="justify-content:center;margin-top:12px"><button class="btn" data-action="go" data-view="home">← Retour</button></div>`; return; }
  if (!E) { setTop('Bulloterie', 'Participant', lock); m.innerHTML = vHomeE(); return; }
  if (v === 'num') { setTop(E.title, 'Ton numéro', lock); m.innerHTML = vNum(); return; }
  if (v === 'pos' && curNum()) { setTop(E.title, `Participant N° ${curNum()}`, lock); m.innerHTML = vPos(); return; }
  if (v === 'send') { setTop('Envoyer mes réponses', 'QR à montrer à l\'administrateur', lock); m.innerHTML = vSend(); return; }
  UI.view = 'home'; setTop(E.title, 'Participant', lock); m.innerHTML = vHomeE();
}
const mineOf = (sid, n) => (ROOT.mine[sid] || {})[n] || {};
const mineDone = (E, n) => E.themes.filter(t => mineOf(E.id, n)[t.id]?.lv).length;
function vHomeE(){
  const E = SE();
  if (!E) return `<div class="hero"><img class="hero-logo" src="icons/icon-512.png" alt=""><h1>Bienvenue !</h1>
      <p class="muted">Scanne le QR code de la séance affiché par l'administrateur de la salle.</p>
      <button class="btn primary big" data-action="go" data-view="scanT">📷 Scanner le QR de la séance</button></div>`;
  const n = curNum(), M = ROOT.mine[E.id] || {};
  const others = Object.keys(M).map(Number).filter(x => E.themes.some(t => M[x][t.id])).sort((a,b) => a-b);
  return `<div class="card strong center">
      <div class="muted">Séance</div><h2>${esc(E.title)}</h2>
      <div class="muted">${E.themes.length} thématique(s)</div>
      ${n ? `<div class="me-row"><div class="bubble me static">${n}</div><div class="left"><b>Participant N° ${n}</b><div class="muted">${mineDone(E, n)} / ${E.themes.length} thématique(s) positionnée(s)</div></div></div>` : ''}
    </div>
    <div class="stack">
      ${n ? `<button class="btn primary big" data-action="go" data-view="pos">🎯 Me positionner</button>
             <button class="btn orange big" data-action="go" data-view="send">📤 Envoyer mes réponses (QR)</button>`
          : `<button class="btn primary big" data-action="go" data-view="num">🔢 Entrer mon numéro</button>`}
      ${n ? `<button class="btn" data-action="changeNum">👤 Changer de participant (appareil partagé)</button>` : ''}
      <button class="btn" data-action="go" data-view="scanT">📷 Scanner une nouvelle séance</button>
    </div>
    ${others.length ? `<div class="card compact"><b>Réponses enregistrées sur cet appareil</b>
      <div class="chips">${others.map(x => `<span class="chip">N° ${x} · ${mineDone(E, x)}/${E.themes.length}</span>`).join('')}</div>
      <div class="muted small">Le QR « Envoyer » contient les réponses de tous ces participants.</div></div>` : ''}`;
}
function vNum(){
  const E = SE(), M = ROOT.mine[E.id] || {}, used = Object.keys(M).map(Number).sort((a,b)=>a-b);
  return `<div class="card strong center"><h2>🔢 Ton numéro</h2><p class="muted">Celui que l'administrateur de la salle t'a donné.</p>
    <div class="num-display">${UI.digits ? esc(UI.digits) : '<span class="ph">–</span>'}</div>
    <div class="pin-pad">${[1,2,3,4,5,6,7,8,9,'⌫',0,'✓'].map(k => `<button data-action="numKey" data-k="${k}" class="${k==='✓'?'ok':''}">${k}</button>`).join('')}</div>
    ${used.length ? `<div class="muted small" style="margin-top:10px">Déjà sur cet appareil :</div><div class="chips center">${used.map(x => `<button class="chip btnchip" data-action="pickNum" data-n="${x}">N° ${x}</button>`).join('')}</div>` : ''}
    </div>
    <div class="btn-row" style="justify-content:center"><button class="btn" data-action="go" data-view="home">← Retour</button></div>`;
}
function vPos(){
  const E = SE(), n = curNum(), M = mineOf(E.id, n), done = mineDone(E, n), tot = E.themes.length;
  return `<div class="pos-head card strong">
      <div class="bubble me static">${n}</div>
      <div class="grow"><b>Fais glisser ta bulle vers ton niveau</b><div class="muted">pour chaque thématique (tu peux aussi toucher une case).</div>
        <div class="progress"><div style="width:${tot ? done/tot*100 : 0}%"></div><span>${done} / ${tot}</span></div></div>
    </div>
    ${E.themes.map((t, i) => { const lv = M[t.id]?.lv || 0, b = `<div class="bubble me drag ${UI.lastDrop === t.id ? 'pop' : ''}" data-drag="me" data-th="${t.id}">${n}</div>`;
      return `<div class="th-card ${lv ? 'done' : ''}">
        <div class="th-title"><span class="th-num">${i+1}</span><span>${esc(t.t)}</span></div>
        <div class="track">
          <div class="dock drop" data-drop="0" data-th="${t.id}" data-action="setMine" data-k="0">${lv ? '' : b}</div>
          ${[1,2,3,4].map(k => `<div class="slot drop ${lv===k?'on':''}" style="--c:${LV[k].c};--l:${LV[k].l}" data-drop="${k}" data-th="${t.id}" data-action="setMine" data-k="${k}">
            <span class="slot-lbl"><span class="e">${LV[k].e}</span>${LV[k].n}</span>${lv === k ? b : ''}</div>`).join('')}
        </div></div>`; }).join('')}
    <div class="stack" style="margin-top:6px">
      <button class="btn orange big" data-action="go" data-view="send">📤 J'ai terminé : afficher mon QR</button>
      <button class="btn" data-action="changeNum">👤 Participant suivant (appareil partagé)</button>
    </div>`;
}
function vSend(){
  const E = SE(), M = ROOT.mine[E.id] || {};
  const nums = Object.keys(M).filter(x => E.themes.some(t => M[x][t.id]));
  return `<div class="card strong center"><b class="big-txt">Montre ce QR à l'administrateur</b>
      <div class="muted">${nums.length ? `Réponses de : ${nums.map(x => 'N° ' + x).join(', ')}` : 'Aucune réponse pour l\'instant'} · luminosité de l'écran au maximum</div></div>
    <div id="qr-area" class="center">Préparation…</div>
    <div class="btn-row" style="justify-content:center;margin-top:12px">
      <button class="btn" data-action="go" data-view="pos">← Modifier mes réponses</button>
      <button class="btn" data-action="fileMine">📤 Partager en fichier</button></div>`;
}
function setMine(th, k){
  const E = SE(), n = curNum(); if (!E || !n) return;
  const M = ROOT.mine[E.id] = ROOT.mine[E.id] || {}, P = M[n] = M[n] || {};
  if ((P[th]?.lv || 0) === k) return;
  P[th] = { lv:k, ts:now() };
  UI.lastDrop = k ? th : null;
  save(); if (navigator.vibrate) navigator.vibrate(25);
  render();
}

/* ---------------------------------------------------------------------
   Glisser-déposer (bulles) — souris, doigt, stylet
   --------------------------------------------------------------------- */
let DR = null, lastDragEnd = 0;
function dropAt(x, y){
  const th = DR.el.dataset.th;
  for (const el of document.elementsFromPoint(x, y)) if (el.classList && el.classList.contains('drop') && el.dataset.th === th) return el;
  return null;
}
document.addEventListener('pointerdown', e => {
  const b = e.target.closest('.drag'); if (!b || (e.button && e.button > 0)) return;
  e.preventDefault();
  DR = { el:b, x0:e.clientX, y0:e.clientY, moved:false, ghost:null, over:null, id:e.pointerId };
});
document.addEventListener('pointermove', e => {
  if (!DR || e.pointerId !== DR.id) return;
  if (!DR.moved && Math.hypot(e.clientX - DR.x0, e.clientY - DR.y0) < 6) return;
  if (!DR.moved) {
    DR.moved = true;
    const r = DR.el.getBoundingClientRect(), g = DR.el.cloneNode(true);
    g.classList.add('ghost'); g.classList.remove('pop', 'fresh'); g.style.width = r.width + 'px'; g.style.height = r.height + 'px';
    DR.ox = DR.x0 - r.left; DR.oy = DR.y0 - r.top;
    document.body.appendChild(g); DR.ghost = g; DR.el.classList.add('dragging'); document.body.classList.add('is-dragging');
  }
  DR.ghost.style.transform = `translate(${e.clientX - DR.ox}px, ${e.clientY - DR.oy}px) scale(1.15)`;
  const z = dropAt(e.clientX, e.clientY);
  if (z !== DR.over) { DR.over && DR.over.classList.remove('over'); DR.over = z; z && z.classList.add('over'); }
  e.preventDefault();
}, { passive:false });
function endDrag(e, cancel){
  if (!DR || (e && e.pointerId !== DR.id)) return;
  const d = DR; DR = null;
  d.ghost && d.ghost.remove(); d.el.classList.remove('dragging'); document.body.classList.remove('is-dragging');
  d.over && d.over.classList.remove('over');
  if (d.moved) lastDragEnd = now();
  if (!cancel && d.moved && d.over) onDrop(d.el, +d.over.dataset.drop);
}
document.addEventListener('pointerup', e => endDrag(e, false));
document.addEventListener('pointercancel', e => endDrag(e, true));
function onDrop(el, k){
  const th = el.dataset.th;
  if (el.dataset.drag === 'me') setMine(th, k);
  else setResp(+el.dataset.drag, th, k);
}

/* ---------------------------------------------------------------------
   Administrateur
   --------------------------------------------------------------------- */
const TABS = [['salle','🏠','Salle'],['themes','🧩','Thématiques'],['people','👥','Participants'],['qr','📲','QR séance'],
  ['recup','📥','Récupérer'],['board','🫧','Tableau'],['synth','📊','Synthèse'],['export','⚙️','Export']];
function renderProf(m){
  const S = SP();
  if (!S && !['salle','export'].includes(UI.tab)) UI.tab = 'salle';
  setTop(S ? S.title : 'Bulloterie', S ? `Administrateur · ${S.people.length} participant(s) · ${S.themes.length} thématique(s)` : 'Administrateur',
    `<button class="btn small light" data-action="lock" aria-label="Verrouiller">🔒</button>`);
  $('#tabs').innerHTML = TABS.map(([k, i, l]) => `<button class="tab ${UI.tab===k?'on':''} ${!S && !['salle','export'].includes(k)?'dis':''}" data-action="tab" data-tab="${k}"><span class="ti">${i}</span>${l}</button>`).join('');
  m.innerHTML = ({ salle:pSalle, themes:pThemes, people:pPeople, qr:pQR, recup:pRecup, board:pBoard, synth:pSynth, export:pExport })[UI.tab](S);
}
const advice = (html, cls='') => `<div class="advice ${cls}">${html}</div>`;

function pSalle(S){
  const list = Object.values(ROOT.salles).sort((a,b) => (b.created||0) - (a.created||0));
  const step = (ok, n, t, tab, sub) => `<button class="step-btn ${ok?'ok':''}" data-action="tab" data-tab="${tab}"><span class="st">${ok?'✓':n}</span><span><b>${t}</b><small>${sub}</small></span></button>`;
  const answered = S ? allNums(S).filter(n => doneCount(S, n)).length : 0;
  return `<div class="card strong"><h2>🏠 Salles / séances</h2>
      ${list.length ? `<div class="salles">${list.map(s => `<div class="salle ${s.id===ROOT.activeP?'on':''}">
        <button class="salle-main" data-action="pickSalle" data-id="${s.id}"><b>${esc(s.title)}</b>
          <small>${s.people.length} participant(s) · ${s.themes.length} thématique(s) · code ${s.id}</small></button>
        <button class="ib" data-action="renSalle" data-id="${s.id}" title="Renommer">✏️</button>
        <button class="ib" data-action="dupSalle" data-id="${s.id}" title="Dupliquer (sans les réponses)">⧉</button>
        <button class="ib red" data-action="delSalle" data-id="${s.id}" title="Supprimer">🗑</button></div>`).join('')}</div>`
        : advice('Créez une première salle (une séance, une formation, un groupe…).', 'info')}
      <div class="row" style="margin-top:12px"><input id="new-salle" class="inp" placeholder="Nom de la nouvelle salle / séance"><button class="btn primary" data-action="newSalle">➕ Créer</button></div>
    </div>
    ${S ? `<div class="card strong"><h2>Déroulement · ${esc(S.title)}</h2><div class="steps">
      ${step(S.themes.length, 1, 'Thématiques', 'themes', `${S.themes.length} thématique(s)`)}
      ${step(S.people.length, 2, 'Participants', 'people', `${S.people.length} numéro(s) attribué(s)`)}
      ${step(false, 3, 'QR de la séance', 'qr', 'À scanner par les participants')}
      ${step(answered, 4, 'Récupérer les QR', 'recup', `${answered} participant(s) reçu(s)`)}
      ${step(false, 5, 'Tableau en direct', 'board', 'Glisser-déposer · projection')}
    </div></div>` : ''}
    ${appQRCard()}`;
}

function pThemes(S){
  return `<div class="card strong"><h2>🧩 Thématiques</h2>
    ${S.themes.length ? `<div class="list">${S.themes.map((t, i) => `<div class="row th-row"><span class="th-num">${i+1}</span>
      <input class="inp" data-change="thName" data-id="${t.id}" value="${esc(t.t)}">
      <button class="ib" data-action="thMove" data-id="${t.id}" data-d="-1" ${i?'':'disabled'}>↑</button>
      <button class="ib" data-action="thMove" data-id="${t.id}" data-d="1" ${i<S.themes.length-1?'':'disabled'}>↓</button>
      <button class="ib red" data-action="thDel" data-id="${t.id}">🗑</button></div>`).join('')}</div>`
      : advice('Aucune thématique : ajoutez celles sur lesquelles les participants vont se positionner.', 'info')}
    <div class="row" style="margin-top:12px"><input id="new-th" class="inp" placeholder="Nouvelle thématique…"><button class="btn primary" data-action="thAdd">➕ Ajouter</button></div>
    <details class="more"><summary>Coller plusieurs thématiques (une par ligne)</summary>
      <textarea id="th-bulk" class="inp" rows="5" placeholder="Utiliser le numérique en EPS&#10;Évaluer par compétences&#10;…"></textarea>
      <button class="btn" data-action="thBulk">➕ Ajouter la liste</button></details>
    ${advice('Après une modification, réaffichez le <b>QR de la séance</b> aux participants.', 'warn')}
  </div>`;
}

function pPeople(S){
  const ppl = [...S.people].sort((a,b) => a.n - b.n), unk = unknownNums(S);
  return `<div class="card strong"><h2>👥 Participants · numéro ↔ nom</h2>
    <p class="muted">Seul cet appareil connaît les noms. Les participants ne reçoivent que la liste des numéros valides.</p>
    <div class="row add-p"><input id="p-num" class="inp num" inputmode="numeric" placeholder="N°"><input id="p-name" class="inp" placeholder="Nom (facultatif)"><button class="btn primary" data-action="pAdd">➕</button></div>
    <details class="more"><summary>Coller une liste de participants</summary>
      <p class="muted small">Une personne par ligne : « 12 Martin Léa », « 12;Martin Léa » ou seulement « Martin Léa » (numéro attribué automatiquement). Copier-coller depuis un tableur possible.</p>
      <textarea id="p-bulk" class="inp" rows="6"></textarea><button class="btn" data-action="pBulk">➕ Ajouter la liste</button></details>
    <div class="btn-row" style="margin:12px 0">
      <button class="btn small" data-action="pNumber" data-m="seq">🔢 Numéroter 1 → ${Math.max(1, S.people.length)}</button>
      <button class="btn small" data-action="pNumber" data-m="rand">🎲 Numéros aléatoires</button>
      <button class="btn small" data-action="pPrint" ${S.people.length?'':'disabled'}>🖨 Étiquettes à distribuer</button>
      <button class="btn small red" data-action="pClear" ${S.people.length?'':'disabled'}>🗑 Tout effacer</button></div>
    <label class="check"><input type="checkbox" data-change="pCheck" ${S.check?'checked':''}> Refuser les numéros non inscrits sur les appareils participants</label>
    ${unk.length ? advice(`Numéros reçus mais non inscrits : ${unk.map(n => `<button class="chip btnchip" data-action="pAddNum" data-n="${n}">➕ N° ${n}</button>`).join(' ')}`, 'warn') : ''}
    ${ppl.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>N°</th><th>Nom</th><th>Réponses</th><th></th></tr></thead><tbody>
      ${ppl.map(p => `<tr><td><input class="inp num" inputmode="numeric" data-change="pNum" data-n="${p.n}" value="${p.n}"></td>
        <td><input class="inp" data-change="pName" data-n="${p.n}" value="${esc(p.name)}"></td>
        <td class="center">${doneCount(S, p.n)} / ${S.themes.length}</td>
        <td><button class="ib red" data-action="pDel" data-n="${p.n}">🗑</button></td></tr>`).join('')}
      </tbody></table></div>` : ''}
  </div>`;
}

function pQR(S){
  if (!S.themes.length) return advice('Ajoutez d\'abord des thématiques (onglet 🧩).', 'warn');
  return `<div class="card strong"><h2>📲 QR de la séance</h2>
      ${advice(`Sur chaque appareil participant : <b>📷 Scanner le QR de la séance</b>, puis entrer son numéro.
        ${S.check ? `Numéros acceptés : ${S.people.length ? S.people.map(p => p.n).sort((a,b)=>a-b).join(', ') : '<b>aucun participant inscrit !</b>'}.` : 'Tous les numéros sont acceptés.'}`, 'info')}
      <div id="qr-seance" class="center">Préparation…</div></div>
    ${appQRCard()}`;
}

function distBar(S, th, big){
  const nums = allNums(S), c = [0,0,0,0,0]; nums.forEach(n => c[lvOf(S, n, th)]++);
  const tot = nums.length || 1;
  return `<div class="dist ${big?'big':''}">${[1,2,3,4,0].map(k => c[k] ? `<div style="flex:${c[k]};--c:${LV[k].c}" title="${LV[k].n} : ${c[k]}">${big ? LV[k].e + ' ' : ''}${c[k]}</div>` : '').join('') || '<div class="empty">—</div>'}</div>`;
}
function pRecup(S){
  return `<div class="recup-grid">
    <div class="card strong"><h2>📥 Scanner les QR des participants</h2>
      <div class="muted small" style="margin-bottom:8px">La caméra reste allumée : présentez les QR les uns après les autres (30–40 cm).</div>
      <div id="recup-scan"></div>
      <div class="btn-row" style="justify-content:center;margin-top:8px"><label class="btn small">📂 Importer des fichiers<input type="file" accept=".json,application/json" multiple hidden data-change="importR"></label></div></div>
    <div id="recup-side">${recupSide()}</div></div>`;
}
function recupSide(){
  const S = SP(); if (!S) return '';
  const nums = allNums(S), resp = nums.filter(n => doneCount(S, n)), full = nums.filter(n => S.themes.length && doneCount(S, n) === S.themes.length);
  const waiting = S.people.filter(p => !doneCount(S, p.n));
  return `<div class="card strong"><div class="kpis">
      <div><b>${resp.length}</b><small>reçu(s)</small></div><div><b>${full.length}</b><small>complet(s)</small></div><div><b>${waiting.length}</b><small>en attente</small></div></div>
      ${S.themes.map(t => `<div class="mini-th"><div class="mini-t">${esc(t.t)}</div>${distBar(S, t.id)}</div>`).join('')}
      ${legend()}
    </div>
    ${waiting.length ? `<div class="card compact"><b>⏳ En attente</b><div class="chips">${waiting.map(p => `<span class="chip">N° ${p.n} · ${esc(p.name || '')}</span>`).join('')}</div></div>` : ''}
    ${S.log.length ? `<div class="card compact"><b>🕘 Derniers QR reçus</b><div class="log">${S.log.slice(0, 8).map(l => `<div><span>${timeTxt(l.at)}</span> appareil ${esc(l.d)} · ${l.nums.map(n => esc(nameOf(S, n))).join(', ') || '—'} · ${l.n} changement(s)</div>`).join('')}</div></div>` : ''}`;
}

function pBoard(S){
  if (!S.themes.length) return advice('Ajoutez d\'abord des thématiques (onglet 🧩).', 'warn');
  const seg = (v, l) => `<button class="${ROOT.disp===v?'on':''}" data-action="disp" data-v="${v}">${l}</button>`;
  return `<div class="board-ctl">
      <div class="th-tabs">${S.themes.map((t, i) => `<button class="${i===UI.th?'on':''}" data-action="thSel" data-i="${i}"><span class="th-num">${i+1}</span>${esc(t.t)}</button>`).join('')}</div>
      <div class="btn-row">
        <div class="seg">${seg('name','Noms')}${seg('num','Numéros')}${seg('hide','Anonyme')}</div>
        <button class="btn small ${UI.dock?'orange':''}" data-action="${UI.dock?'dockOff':'dockOn'}">📷 ${UI.dock?'Réception active':'Recevoir des QR ici'}</button>
        <button class="btn small" data-action="proj">${UI.proj?'↙ Quitter la projection':'🖥 Projeter'}</button>
      </div></div>
    <div id="board-area">${boardArea()}</div>`;
}
function bubbleP(S, n, th){
  const f = UI.fresh && now() - UI.fresh.at < 8000 && UI.fresh.set.has(n + '|' + th);
  const label = ROOT.disp === 'num' ? n : ROOT.disp === 'hide' ? '' : (personOf(S, n)?.name || 'N° ' + n);
  return `<div class="bubble p drag ${f?'fresh':''} ${personOf(S, n)?'':'unk'}" data-drag="${n}" data-th="${th}" title="${esc(nameOf(S, n))}">${esc(label)}</div>`;
}
function boardArea(){
  const S = SP(); if (!S || !S.themes.length) return '';
  UI.th = Math.max(0, Math.min(S.themes.length - 1, UI.th));
  const t = S.themes[UI.th], nums = allNums(S), by = [[],[],[],[],[]];
  nums.forEach(n => by[lvOf(S, n, t.id)].push(n));
  const sortB = a => a.sort((x, y) => ROOT.disp === 'name' ? nameOf(S, x).localeCompare(nameOf(S, y), 'fr') : x - y);
  return `<div class="board-title"><button class="ib big" data-action="thStep" data-d="-1">◀</button>
      <h2><span class="th-num">${UI.th+1}</span>${esc(t.t)}</h2><button class="ib big" data-action="thStep" data-d="1">▶</button></div>
    <div class="col0 drop" data-drop="0" data-th="${t.id}"><span class="col0-h">⏳ Pas encore positionnés <b>${by[0].length}</b></span>${sortB(by[0]).map(n => bubbleP(S, n, t.id)).join('')}</div>
    <div class="board ${ROOT.disp==='hide'?'anon':''}">${[1,2,3,4].map(k => `<div class="col drop" data-drop="${k}" data-th="${t.id}" style="--c:${LV[k].c};--l:${LV[k].l}">
      <div class="col-h"><span>${LV[k].e} ${LV[k].n}</span><b class="cnt">${by[k].length}</b></div>
      <div class="col-b">${sortB(by[k]).map(n => bubbleP(S, n, t.id)).join('')}</div></div>`).join('')}</div>
    ${distBar(S, t.id, true)}`;
}
function setResp(n, th, k){
  const S = SP(); if (!S) return;
  const R = S.resp[n] = S.resp[n] || {};
  if ((R[th]?.lv || 0) === k) return;
  R[th] = { lv:k, ts:now(), by:'admin' };
  UI.fresh = { set:new Set([n + '|' + th]), at:now() };
  save(); refreshLive();
}

function pSynth(S){
  if (!S.themes.length) return advice('Ajoutez d\'abord des thématiques (onglet 🧩).', 'warn');
  const nums = allNums(S).sort((a,b) => UI.sort === 'name' ? nameOf(S, a).localeCompare(nameOf(S, b), 'fr') : a - b);
  const seg = (v, l) => `<button class="${UI.sort===v?'on':''}" data-action="sort" data-v="${v}">${l}</button>`;
  return `<div class="card strong"><h2>📊 Synthèse · ${esc(S.title)}</h2>
      <div class="btn-row" style="margin-bottom:10px"><div class="seg">${seg('num','Trier par numéro')}${seg('name','Trier par nom')}</div><button class="btn small" data-action="csv">⬇️ Export CSV (Excel)</button></div>
      ${legend()}
      <div class="tbl-wrap"><table class="synth"><thead><tr><th>N°</th><th>Nom</th>${S.themes.map((t, i) => `<th title="${esc(t.t)}"><span class="th-num">${i+1}</span><div class="th-l">${esc(t.t)}</div></th>`).join('')}<th>✓</th></tr></thead>
      <tbody>${nums.map(n => `<tr><td><b>${n}</b></td><td class="nm ${personOf(S, n)?'':'unk'}">${esc(personOf(S, n)?.name || (personOf(S, n) ? '' : 'non inscrit'))}</td>
        ${S.themes.map(t => { const k = lvOf(S, n, t.id); return `<td class="c" style="--c:${LV[k].c};--l:${LV[k].l}" data-action="cell" data-n="${n}" data-th="${t.id}" title="${LV[k].n}">${k ? LV[k].e : '·'}</td>`; }).join('')}
        <td class="center">${doneCount(S, n)}/${S.themes.length}</td></tr>`).join('') || `<tr><td colspan="${S.themes.length + 3}" class="center muted">Aucun participant</td></tr>`}</tbody></table></div>
    </div>
    <div class="card strong"><h2>Répartition par thématique</h2>
      ${S.themes.map((t, i) => `<div class="mini-th"><div class="mini-t"><span class="th-num">${i+1}</span>${esc(t.t)}</div>${distBar(S, t.id, true)}</div>`).join('')}</div>`;
}

function pExport(S){
  return `${S ? `<div class="card strong"><h2>⬇️ Export · ${esc(S.title)}</h2><div class="btn-row">
      <button class="btn" data-action="csv">📊 Tableau CSV (Excel)</button>
      <button class="btn red" data-action="clearResp">🧹 Effacer les réponses de cette salle</button></div></div>` : ''}
    <div class="card strong"><h2>💾 Sauvegarde</h2><p class="muted">Toutes les salles de cet appareil (thématiques, participants, réponses).</p>
      <div class="btn-row"><button class="btn" data-action="backup">💾 Sauvegarder (.json)</button>
      <label class="btn">📂 Restaurer une sauvegarde<input type="file" accept=".json,application/json" hidden data-change="restore"></label></div></div>
    <div class="card strong"><h2>🔒 Code administrateur</h2><p class="muted">Code actuel : 4 chiffres (par défaut 0000).</p>
      <button class="btn" data-action="setPin">Changer le code</button></div>
    <div class="card strong"><h2>🙋 Cet appareil</h2><p class="muted">Identifiant : ${esc(ROOT.deviceId)} · version ${APP_VERSION}</p>
      <button class="btn" data-action="setRole" data-r="eleve">Utiliser cet appareil comme participant</button></div>`;
}

/* Étiquettes à découper et distribuer */
function printLabels(S){
  const ppl = [...S.people].sort((a,b) => (a.name||'').localeCompare(b.name||'', 'fr') || a.n - b.n);
  $('#print-root').innerHTML = `<div class="labels">${ppl.map(p => `<div class="label"><div class="lt">${esc(S.title)}</div>
    <div class="ln">${esc(p.name || '')}</div><div class="lnum">N° ${p.n}</div><div class="lf">Bulloterie · garde ton numéro secret</div></div>`).join('')}</div>`;
  setTimeout(() => window.print(), 100);
}
function exportCSV(S){
  const q = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [['Numéro', 'Nom', ...S.themes.map(t => t.t), 'Thématiques renseignées']];
  allNums(S).forEach(n => rows.push([n, personOf(S, n)?.name || '', ...S.themes.map(t => { const k = lvOf(S, n, t.id); return k ? LV[k].n : ''; }), doneCount(S, n)]));
  rows.push([]);
  [1,2,3,4,0].forEach(k => rows.push(['', k ? 'Total ' + LV[k].n : 'Total non positionné', ...S.themes.map(t => allNums(S).filter(n => lvOf(S, n, t.id) === k).length), '']));
  downloadFile('﻿' + rows.map(r => r.map(q).join(';')).join('\r\n'), `Bulloterie_${fileSafe(S.title)}.csv`, 'text/csv;charset=utf-8');
}
/* Renumérotation : les réponses suivent le participant */
function renumber(S, map){
  const resp = {};
  Object.entries(S.resp).forEach(([n, r]) => { const to = map.has(+n) ? map.get(+n) : +n; resp[to] = r; });
  S.people.forEach(p => { if (map.has(p.n)) p.n = map.get(p.n); });
  S.resp = resp;
}
function nextFree(S){ let n = 1; const used = new Set(allNums(S)); while (used.has(n)) n++; return n; }
function pinPad(onOk, title='🔒 Code administrateur', setNew=false){
  let code = '';
  const m = modal(`<h2 class="center">${title}</h2><div class="pin-dots">${'<span></span>'.repeat(4)}</div>
    <div class="pin-pad">${[1,2,3,4,5,6,7,8,9,'⌫',0,'✕'].map(k=>`<button data-k="${k}">${k}</button>`).join('')}</div>
    ${setNew ? '' : '<p class="center muted small">Code par défaut : 0000 (modifiable dans ⚙️ Export)</p>'}`);
  const dots = m.querySelectorAll('.pin-dots span');
  m.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
    const k = b.dataset.k;
    if (k === '✕') return closeModal();
    if (k === '⌫') code = code.slice(0,-1); else if (code.length < 4) code += k;
    dots.forEach((d,i)=>d.classList.toggle('f', i < code.length));
    if (code.length === 4) {
      if (setNew) { closeModal(); onOk(code); }
      else if (code === String(ROOT.pin || '0000')) { closeModal(); onOk(); }
      else { toast('Code incorrect'); code=''; dots.forEach(d=>d.classList.remove('f')); }
    }
  });
}

/* ---------------------------------------------------------------------
   Actions (délégation d'événements)
   --------------------------------------------------------------------- */
const A = {
  home: () => { if (ROOT.role === 'prof' && UI.profUnlocked) { UI.proj = false; UI.tab = 'salle'; } UI.view = 'home'; render(); window.scrollTo(0,0); },
  go: d => go(d.view),
  setRole: d => {
    if (d.r === 'prof') return pinPad(() => { ROOT.role = 'prof'; UI.profUnlocked = true; UI.tab = SP() ? 'salle' : 'salle'; save(); render(); });
    ROOT.role = 'eleve'; UI.profUnlocked = false; UI.proj = false; UI.view = 'home'; save(); render();
  },
  toProf: () => pinPad(() => { ROOT.role = 'prof'; UI.profUnlocked = true; UI.tab = 'salle'; save(); render(); }),
  unlock: () => pinPad(() => { UI.profUnlocked = true; render(); }),
  lock: () => { UI.profUnlocked = false; UI.proj = false; render(); },
  appQR: () => { const m = modal(`<h2 class="center">📲 Accès à l'application</h2><div class="center"><img src="${appQRImg(12)}" alt="QR" style="width:min(80vw,460px);height:auto"></div>
      <p class="center app-url">${esc(appURL())}</p><div class="btn-row" style="justify-content:center"><button class="btn primary" data-close>Fermer</button></div>`, { wide:true });
    m.querySelector('[data-close]').onclick = closeModal; },

  /* participant */
  changeNum: () => { UI.digits = ''; go('num'); },
  numKey: d => {
    const k = d.k;
    if (k === '⌫') UI.digits = UI.digits.slice(0, -1);
    else if (k === '✓') return A.pickNum({ n: UI.digits });
    else if (UI.digits.length < 4) UI.digits = (UI.digits + k).replace(/^0+/, '');
    const el = $('.num-display'); if (el) el.innerHTML = UI.digits ? esc(UI.digits) : '<span class="ph">–</span>';
  },
  pickNum: d => {
    const E = SE(), n = normNum(d.n);
    if (!n) return toast('Entre ton numéro');
    if (E.nums && E.nums.length && !E.nums.includes(n)) { toast(`⚠️ N° ${n} inconnu dans cette séance : vérifie avec l'administrateur`, 3500); UI.digits = ''; return render(); }
    ROOT.cur[E.id] = n; UI.digits = ''; UI.lastDrop = null; save(); go('pos');
  },
  setMine: d => { if (now() - lastDragEnd < 250) return; setMine(d.th, +d.k); },
  fileMine: () => { const E = SE(); if (E) downloadFile(JSON.stringify(buildR(E.id)), `Bulloterie_${fileSafe(E.title)}_${ROOT.deviceId}.json`); },

  /* administrateur */
  tab: d => { const S = SP(); if (!S && !['salle','export'].includes(d.tab)) return toast('Créez ou choisissez d\'abord une salle'); UI.tab = d.tab; if (d.tab !== 'board') UI.proj = false; render(); window.scrollTo(0,0); },
  newSalle: () => { const v = $('#new-salle').value.trim(); if (!v) return toast('Donnez un nom à la salle');
    const s = newSalle(v); ROOT.salles[s.id] = s; ROOT.activeP = s.id; save(); UI.tab = 'themes'; render(); toast('✓ Salle créée : ajoutez les thématiques'); },
  pickSalle: d => { ROOT.activeP = d.id; UI.th = 0; save(); render(); },
  renSalle: async d => { const s = ROOT.salles[d.id]; const v = await promptBox('Renommer la salle', 'Nom', s.title); if (v) { s.title = v; save(); render(); } },
  dupSalle: d => { const s = ROOT.salles[d.id], c = newSalle(s.title + ' (copie)');
    c.themes = s.themes.map(t => ({ ...t })); c.people = s.people.map(p => ({ ...p })); c.check = s.check;
    ROOT.salles[c.id] = c; ROOT.activeP = c.id; save(); render(); toast('✓ Salle dupliquée (sans les réponses)'); },
  delSalle: async d => { const s = ROOT.salles[d.id];
    if (!(await confirmBox('Supprimer la salle ?', `« ${esc(s.title)} » : thématiques, participants et réponses seront effacés.`, 'Supprimer', true))) return;
    delete ROOT.salles[d.id]; if (ROOT.activeP === d.id) ROOT.activeP = Object.keys(ROOT.salles)[0] || null; save(); render(); },

  thAdd: () => { const v = $('#new-th').value.trim(); if (!v) return; SP().themes.push({ id:rnd(3), t:v }); save(); render(); setTimeout(() => $('#new-th')?.focus(), 30); },
  thBulk: () => { const S = SP(); const L = $('#th-bulk').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    L.forEach(t => S.themes.push({ id:rnd(3), t })); save(); render(); toast(`✓ ${L.length} thématique(s) ajoutée(s)`); },
  thMove: d => { const T = SP().themes, i = T.findIndex(t => t.id === d.id), j = i + +d.d; if (j < 0 || j >= T.length) return;
    [T[i], T[j]] = [T[j], T[i]]; save(); render(); },
  thDel: async d => { const S = SP(), t = S.themes.find(x => x.id === d.id);
    if (!(await confirmBox('Supprimer la thématique ?', `« ${esc(t.t)} » et les positionnements associés.`, 'Supprimer', true))) return;
    S.themes = S.themes.filter(x => x.id !== d.id); Object.values(S.resp).forEach(r => delete r[d.id]); save(); render(); },

  pAdd: () => { const S = SP(); let n = normNum($('#p-num').value); const name = $('#p-name').value.trim();
    if (!n) n = nextFree(S);
    if (personOf(S, n)) return toast(`Le N° ${n} est déjà attribué`);
    S.people.push({ n, name }); save(); render(); setTimeout(() => $('#p-num')?.focus(), 30); },
  pAddNum: d => { const S = SP(); const n = +d.n; if (!personOf(S, n)) S.people.push({ n, name:'' }); save(); render(); },
  pBulk: () => { const S = SP(); let added = 0, skipped = 0;
    $('#p-bulk').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(line => {
      let n = null, name = line;
      const a = line.match(/^\s*(\d+)\s*[;,\t ]?\s*(.*)$/), b = line.match(/^(.*?)[;,\t ]+(\d+)\s*$/);
      if (a) { n = +a[1]; name = a[2]; } else if (b) { n = +b[2]; name = b[1]; }
      name = name.replace(/[;\t]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!n) n = nextFree(S);
      if (personOf(S, n)) { skipped++; return; }
      S.people.push({ n, name }); added++;
    });
    save(); render(); toast(`✓ ${added} participant(s) ajouté(s)${skipped ? ` · ${skipped} numéro(s) déjà pris` : ''}`, 3000); },
  pNumber: async d => { const S = SP(); if (!S.people.length) return toast('Aucun participant');
    const hasResp = Object.keys(S.resp).length;
    if (!(await confirmBox('Renuméroter les participants ?', `${d.m === 'rand' ? 'Numéros aléatoires (difficiles à deviner).' : 'Numéros de 1 à ' + S.people.length + ' dans l\'ordre alphabétique.'}${hasResp ? '<br><b>Les réponses déjà reçues suivent leur participant, mais les appareils participants devront rescanner le QR de la séance.</b>' : ''}`, 'Renuméroter'))) return;
    const ppl = [...S.people].sort((a,b) => (a.name||'').localeCompare(b.name||'', 'fr') || a.n - b.n);
    let nums;
    if (d.m === 'rand') { const lo = ppl.length <= 80 ? 10 : 100, hi = ppl.length <= 80 ? 99 : 999; const pool = []; for (let i = lo; i <= hi; i++) pool.push(i);
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; } nums = pool.slice(0, ppl.length); }
    else nums = ppl.map((_, i) => i + 1);
    const tmp = new Map(ppl.map((p, i) => [p.n, -(i + 1)])); renumber(S, tmp);             // passage par des numéros temporaires
    renumber(S, new Map(ppl.map((p, i) => [-(i + 1), nums[i]])));
    save(); render(); toast('✓ Participants renumérotés'); },
  pPrint: () => printLabels(SP()),
  pClear: async () => { if (!(await confirmBox('Effacer tous les participants ?', 'Les réponses reçues sont conservées (numéros non inscrits).', 'Effacer', true))) return;
    SP().people = []; save(); render(); },
  pDel: d => { const S = SP(); S.people = S.people.filter(p => p.n !== +d.n); save(); render(); },

  dockOn: () => { UI.dock = true; render(); },
  dockOff: () => { closeDock(); if (UI.tab === 'board') render(); },
  proj: () => { UI.proj = !UI.proj;
    try { if (UI.proj && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(()=>{});
      else if (!UI.proj && document.fullscreenElement) document.exitFullscreen().catch(()=>{}); } catch(e){}
    render(); },
  disp: d => { ROOT.disp = d.v; save(); render(); },
  thSel: d => { UI.th = +d.i; render(); },
  thStep: d => { const S = SP(); UI.th = (UI.th + +d.d + S.themes.length) % S.themes.length; render(); },
  sort: d => { UI.sort = d.v; render(); },
  cell: d => { const S = SP(), n = +d.n, th = d.th, t = S.themes.find(x => x.id === th);
    const m = modal(`<h2>${esc(nameOf(S, n))}</h2><p class="muted">${esc(t.t)}</p><div class="stack">${[1,2,3,4,0].map(k =>
      `<button class="btn lvbtn ${lvOf(S, n, th)===k?'on':''}" style="--c:${LV[k].c};--l:${LV[k].l}" data-k="${k}">${LV[k].e} ${LV[k].n}</button>`).join('')}</div>`);
    m.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { closeModal(); setResp(n, th, +b.dataset.k); render(); }); },
  csv: () => exportCSV(SP()),
  clearResp: async () => { const S = SP(); if (!(await confirmBox('Effacer les réponses ?', `Tous les positionnements de « ${esc(S.title)} » seront effacés.`, 'Effacer', true))) return;
    S.resp = {}; S.log = []; save(); render(); },
  backup: () => downloadFile(JSON.stringify({ app:'bulloterie', v:APP_VERSION, salles:ROOT.salles, pin:ROOT.pin }), `Bulloterie_sauvegarde_${new Date().toISOString().slice(0,10)}.json`),
  setPin: () => pinPad(code => { ROOT.pin = code; save(); toast('✓ Nouveau code enregistré'); }, 'Nouveau code (4 chiffres)', true),
};

/* Champs modifiés (change) */
const CH = {
  thName: (el) => { const t = SP().themes.find(x => x.id === el.dataset.id); const v = el.value.trim(); if (t && v) { t.t = v; save(); } else render(); },
  pName: (el) => { const p = personOf(SP(), +el.dataset.n); if (p) { p.name = el.value.trim(); save(); } },
  pNum: (el) => { const S = SP(), old = +el.dataset.n, n = normNum(el.value);
    if (!n || n === old) return render();
    if (personOf(S, n)) { toast(`Le N° ${n} est déjà attribué`); return render(); }
    renumber(S, new Map([[old, n]])); save(); render(); },
  pCheck: (el) => { SP().check = el.checked; save(); },
  importR: async (el) => { let tot = 0;
    for (const f of el.files) { try { const p = JSON.parse(await f.text()); if (p.k !== 'R') throw new Error('Fichier non reconnu'); tot += applyR(p).np; } catch(e) { toast('⚠️ ' + f.name + ' : ' + e.message, 3500); } }
    el.value = ''; if (tot) toast(`✓ ${tot} participant(s) importé(s)`); refreshLive(); },
  restore: async (el) => { const f = el.files[0]; el.value = ''; if (!f) return;
    try { const o = JSON.parse(await f.text()); if (o.app !== 'bulloterie' || !o.salles) throw new Error('Ce n\'est pas une sauvegarde Bulloterie');
      if (!(await confirmBox('Restaurer la sauvegarde ?', 'Les salles de la sauvegarde remplacent celles qui ont le même code ; les autres sont conservées.', 'Restaurer'))) return;
      Object.values(o.salles).forEach(s => { ROOT.salles[s.id] = normSalle(s); });
      if (!SP()) ROOT.activeP = Object.keys(ROOT.salles)[0] || null;
      save(); render(); toast('✓ Sauvegarde restaurée');
    } catch(e) { toast('⚠️ ' + e.message, 3500); } },
};

document.addEventListener('click', e => {
  const b = e.target.closest('[data-action]'); if (!b || b.disabled) return;
  const fn = A[b.dataset.action]; if (!fn) return;
  e.preventDefault(); fn({ ...b.dataset });
});
document.addEventListener('change', e => { const el = e.target.closest('[data-change]'); if (el && CH[el.dataset.change]) CH[el.dataset.change](el); });
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'new-salle') A.newSalle();
  if (e.key === 'Enter' && e.target.id === 'new-th') A.thAdd();
  if (e.key === 'Enter' && (e.target.id === 'p-name' || e.target.id === 'p-num')) A.pAdd();
  if (UI.tab === 'board' && ROOT.role === 'prof' && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
    if (e.key === 'ArrowRight') A.thStep({ d:1 }); if (e.key === 'ArrowLeft') A.thStep({ d:-1 });
    if (e.key === 'Escape' && UI.proj) A.proj();
  }
});
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && UI.proj) { UI.proj = false; render(); } });
/* Les bulles « fraîches » perdent leur halo après quelques secondes */
setInterval(() => { if (UI.fresh && now() - UI.fresh.at > 8000 && now() - UI.fresh.at < 9500) { document.querySelectorAll('.bubble.fresh').forEach(b => b.classList.remove('fresh')); } }, 1000);

/* ---------------------------------------------------------------------
   Démarrage
   --------------------------------------------------------------------- */
$('#app-version').textContent = 'v' + APP_VERSION;
if (ROOT.role === 'prof' && !SP() && Object.keys(ROOT.salles).length) ROOT.activeP = Object.keys(ROOT.salles)[0];
render();
if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
