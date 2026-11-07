/* 帳號密碼紀錄系統 — 介面（PWA 與桌面 exe 共用） */
(function () {
  'use strict';
  const VERSION = '1.2.0';
  const qs = new URLSearchParams(location.search);
  const DESKTOP = qs.has('desktop');
  const SELFTEST = qs.has('selftest');
  const LS_KEY = 'pwvault.v1';
  const $ = (s, el) => (el || document).querySelector(s);
  const app = $('#app'), modal = $('#modal');

  const S = {
    session: null, data: null, api: null, lastAct: Date.now(), fails: 0,
    v: { filter: 'all', q: '', sel: null, edit: null, sort: 'name', showPw: false, sideOpen: false }
  };

  /* ---------- 儲存 ---------- */
  function apiReady() {
    return new Promise(res => {
      if (window.pywebview && window.pywebview.api) return res(window.pywebview.api);
      window.addEventListener('pywebviewready', () => res(window.pywebview.api), { once: true });
    });
  }
  let memStore = null; // 瀏覽器自我測試用，不碰真資料
  const Store = {
    async load() {
      if (SELFTEST && !DESKTOP) return memStore;
      if (DESKTOP) return await S.api.load_vault();
      try { return localStorage.getItem(LS_KEY); } catch (e) { return null; }
    },
    async save(text) {
      if (SELFTEST && !DESKTOP) { memStore = text; return; }
      if (DESKTOP) { const r = await S.api.save_vault(text); if (r !== true) throw new Error(r || '寫入失敗'); return; }
      localStorage.setItem(LS_KEY, text);
    }
  };
  async function persistLocal() {
    try { const t = await PV.seal(S.session, S.data); await Store.save(t); S.lastSealed = t; }
    catch (e) { toast('⚠ 儲存失敗：' + e.message, 6000); throw e; }
  }
  async function persist() {
    await persistLocal();
    if (Cloud.cfg) { Cloud.cfg.dirty = true; await Cloud.save(); scheduleSync(800); }
  }

  /* ---------- Google 雲端同步（只傳密文） ---------- */
  const CLOUD_KEY = 'pwvault.cloud';
  let memCloud = null;
  const Cloud = {
    cfg: null,
    async load() {
      let t = null;
      if (SELFTEST && !DESKTOP) t = memCloud;
      else if (DESKTOP) t = await S.api.get_cloud();
      else { try { t = localStorage.getItem(CLOUD_KEY); } catch (e) { } }
      try { this.cfg = t ? JSON.parse(t) : null; } catch (e) { this.cfg = null; }
      return this.cfg;
    },
    async save() {
      const t = this.cfg ? JSON.stringify(this.cfg) : '';
      if (SELFTEST && !DESKTOP) memCloud = t;
      else if (DESKTOP) await S.api.set_cloud(t);
      else if (t) localStorage.setItem(CLOUD_KEY, t); else localStorage.removeItem(CLOUD_KEY);
    }
  };
  function okCloudUrl(u) {
    return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u) || /^http:\/\/(127\.0\.0\.1|localhost):\d+\/[\w/-]*$/.test(u);
  }
  async function cloudCall(body, cfg) {
    cfg = cfg || Cloud.cfg;
    let r;
    try {
      r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ key: cfg.key }, body)), cache: 'no-store', redirect: 'follow' });
    } catch (e) { throw new Error('連不上 Google（網路中斷？）'); }
    if (!r.ok) throw new Error('雲端錯誤 HTTP ' + r.status);
    let j;
    try { j = await r.json(); } catch (e) { throw new Error('雲端回應格式不對（網址錯誤或尚未授權部署）'); }
    if (!j.ok && j.err !== 'CONFLICT') {
      throw new Error({ BAD_KEY: '同步密碼錯誤', NOT_SETUP: '雲端還沒設定同步密碼', NOT_VAULT: '資料格式錯誤' }[j.err] || j.err);
    }
    return j;
  }
  S.sync = { state: 'off', msg: '' };
  function setSync(state, msg) {
    S.sync = { state, msg: msg || '' };
    const el = $('#syncst'); if (el) el.outerHTML = syncHtml();
    if (state !== 'busy' && S.data && !S.v.sel && !S.v.edit && $('.overview')) renderDetail();
  }
  function syncHtml() {
    const c = Cloud.cfg, s = S.sync;
    if (!c) return `<a id="syncst" data-act="cloudset" class="sync off"><span class="dot"></span><span class="lbl">未連線 Google 雲端</span>${I('cloud', 'sm')}</a>`;
    const t = c.at ? fmtTime(c.at).slice(11) : '';
    const [cls, txt] = s.state === 'busy' ? ['busy', '同步中…'] : s.state === 'err' ? ['bad', '同步失敗'] : c.dirty ? ['wait', '等待上傳'] : ['', `已同步 ${t}`];
    return `<a id="syncst" data-act="syncnow" class="sync ${cls}" title="${esc(s.msg || '點一下立即同步')}"><span class="dot"></span><span class="lbl">${txt}</span>${I('refresh', 'sm')}</a>`;
  }
  let syncBusy = false, syncAgain = false, syncTimer = 0;
  function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, ms); }
  // 把雲端版本併進來；回傳 true = 本機有雲端沒有的變更（需要上傳），null = 取消
  async function absorb(text) {
    let remote = await PV.openWith(text, S.session);
    if (!remote) {
      const pw = await promptPw('輸入雲端的主密碼', '雲端資料是用另一個主密碼加密的（可能在別台裝置改過主密碼）。輸入後本機也會改用這個主密碼。');
      if (pw == null) return null;
      try { const o = await PV.open(text, pw); remote = o.data; S.session = o.session; toast('已改用雲端的主密碼', 4000); }
      catch (e) { toast('雲端主密碼錯誤', 4000); return null; }
    }
    remote = defaults(remote);
    const merged = defaults(PV.merge(S.data, remote));
    const needPush = !PV.sameEntries(merged, remote);
    const localChanged = !PV.sameEntries(merged, S.data);
    S.data = merged;
    await persistLocal();
    if (localChanged && $('#shell')) {
      if (S.v.edit) readEdit();
      if (S.v.sel && !cur()) S.v.sel = null;
      renderAll();
    }
    return needPush;
  }
  async function syncNow() {
    const c = Cloud.cfg;
    if (!c || !S.session) return;
    if (syncBusy) { syncAgain = true; return; }
    clearTimeout(syncTimer);
    syncBusy = true; setSync('busy');
    try {
      for (let i = 0; i < 4; i++) {
        const r = await cloudCall({ a: 'rev' }, c);
        if (r.rev !== c.rev) {
          const l = await cloudCall({ a: 'load' }, c);
          if (l.vault) {
            const need = await absorb(l.vault);
            if (need === null) { setSync('err', '需要雲端的主密碼'); return; }
            if (need) c.dirty = true;
          }
          c.rev = l.rev; await Cloud.save();
        }
        if (!c.dirty || !S.session) break;
        const s = await cloudCall({ a: 'save', baseRev: c.rev, vault: await PV.seal(S.session, S.data) }, c);
        if (s.ok) { c.rev = s.rev; c.dirty = false; await Cloud.save(); break; }
        // CONFLICT：別台剛上傳過，重新下載合併再傳
      }
      c.at = Date.now(); await Cloud.save();
      setSync('ok');
    } catch (e) { setSync('err', e.message); }
    finally {
      syncBusy = false;
      if (syncAgain) { syncAgain = false; scheduleSync(300); }
    }
  }
  // 上鎖時還沒傳上去的變更：直接送最後一次存檔的密文（衝突就留到下次解鎖再合併）
  function flushOnLock() {
    const c = Cloud.cfg, t = S.lastSealed;
    if (!c || !c.dirty || !t || syncBusy) return;
    cloudCall({ a: 'save', baseRev: c.rev, vault: t }, c).then(async s => {
      if (s.ok) { c.rev = s.rev; c.dirty = false; c.at = Date.now(); await Cloud.save(); }
    }).catch(() => {});
  }
  async function connectCloud(url, key) {
    url = (url || '').trim();
    if (!okCloudUrl(url)) throw new Error('網址格式不對，應該是 https://script.google.com/macros/s/…/exec');
    if ((key || '').length < 6) throw new Error('同步密碼至少 6 個字');
    const cfg = { url, key, rev: 0, dirty: true };
    await cloudCall({ a: 'ping' }, cfg);
    Cloud.cfg = cfg; await Cloud.save();
    await syncNow();
    if (S.sync.state === 'err') throw new Error(S.sync.msg);
  }
  async function disconnectCloud() {
    Cloud.cfg = null; await Cloud.save(); setSync('off');
  }

  /* ---------- 小工具 ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  let toastT;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    t.classList.toggle('bad', /失敗|錯誤|⚠|不對|無法/.test(msg));
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms || 2600);
  }
  // 線條圖示（24×24，currentColor）
  const ICONS = {
    all: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    star: '<path d="M12 2.8l2.85 5.78 6.38.93-4.62 4.5 1.09 6.35L12 17.36l-5.7 3 1.09-6.35-4.62-4.5 6.38-.93z"/>',
    folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    dice: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2.5"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
    search: '<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    dup: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2M15 12v6M12 15h6"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 6.5V12l3.5 2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 16v-4M12 8h.01"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>'
  };
  function I(name, cls) { return `<svg class="i ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`; }
  function hue(s) { let h = 0; for (const c of s || '?') h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function avatar(e) {
    const ch = ([...(e.title || '?').trim()][0] || '?').toUpperCase(), h = hue(e.title);
    return `<div class="av" style="background:linear-gradient(135deg,hsl(${h} 62% 52%),hsl(${(h + 28) % 360} 58% 40%))">${esc(ch)}</div>`;
  }
  function fmtTime(t) {
    if (!t) return '';
    const d = new Date(t), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function ymd() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; }
  function normUrl(u) { u = (u || '').trim(); if (!u) return ''; return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : 'https://' + u; }
  function meter(pw) {
    const s = PV.strength(pw);
    return `<div class="meter s${s.score} ${pw ? '' : 'empty'}"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="sl">${pw ? `強度 <b class="s${s.score}">${s.label}</b>　約 ${s.bits} bits` : ''}</div>`;
  }
  function strengthBadge(s) { return `<span class="badge ${s.score >= 3 ? 'ok' : s.score === 2 ? 'warn' : 'bad'}">${I('shield', 'sm')}${s.label}</span>`; }
  // 對話框標題：圖示 + 文字
  function dh(icon, title, bad) { return `<h3><span class="hi ${bad ? 'bad' : ''}">${I(icon)}</span>${esc(title)}</h3>`; }
  function defaults(d) {
    d = d || {};
    d.v = 1; d.entries = d.entries || []; d.deleted = d.deleted || {};
    d.settings = Object.assign({ lockMin: 5, clipSec: 20 }, d.settings || {});
    d.settings.gen = Object.assign({ length: 16, upper: true, lower: true, digits: true, symbols: true, noAmbig: true }, d.settings.gen || {});
    return d;
  }
  function dupKey(e) { return [(PV.hostOf(e.url) || e.title || '').toLowerCase(), e.username || '', e.password || ''].join('\n'); }
  function newEntry(o) {
    const now = Date.now();
    return Object.assign({ id: PV.uid(), title: '', url: '', username: '', password: '', notes: '', category: '', tags: [], fav: false, history: [], createdAt: now, updatedAt: now }, o);
  }

  /* ---------- 剪貼簿 ---------- */
  let clipToken = 0;
  async function copy(text, label) {
    const sec = S.data ? S.data.settings.clipSec : 20;
    try {
      if (DESKTOP) await S.api.copy(text, sec);
      else {
        try { await navigator.clipboard.writeText(text); }
        catch (e) {
          const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        }
        const my = ++clipToken;
        if (sec > 0) setTimeout(() => { if (my === clipToken) navigator.clipboard.writeText('').catch(() => {}); }, sec * 1000);
      }
      toast(`已複製${label || ''}` + (sec > 0 ? `，${sec} 秒後自動清除剪貼簿` : ''));
    } catch (e) { toast('複製失敗：' + e.message); }
  }
  function openUrl(u) {
    u = normUrl(u);
    if (!/^https?:\/\//i.test(u)) return toast('只能開啟 http / https 網址');
    if (DESKTOP) S.api.open_url(u); else window.open(u, '_blank', 'noopener,noreferrer');
  }

  /* ---------- 視窗 ---------- */
  function closeModal() { modal.classList.add('hidden'); modal.innerHTML = ''; modal.onclick = null; }
  function openModal(html, wire) {
    modal.innerHTML = `<div class="dialog" role="dialog">${html}</div>`;
    modal.classList.remove('hidden');
    modal.onclick = e => { if (e.target === modal) closeModal(); };
    if (wire) wire(modal.firstElementChild);
    const f = modal.querySelector('[autofocus]'); if (f) f.focus();
  }
  function confirmBox(title, msg, okText, danger) {
    return new Promise(res => {
      openModal(`${dh(danger ? 'alert' : 'info', title, danger)}<div style="color:var(--text-2)">${msg}</div><div class="btns">
        <button data-r="0">取消</button><button data-r="1" class="${danger ? 'danger-solid' : 'primary'}" autofocus>${esc(okText || '確定')}</button></div>`,
      d => d.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { closeModal(); res(b.dataset.r === '1'); }));
    });
  }
  function promptPw(title, msg) {
    return new Promise(res => {
      openModal(`${dh('key', title)}<div class="muted">${msg || ''}</div>
        <input type="password" id="pp" autocomplete="off" autofocus style="margin-top:10px">
        <div class="btns"><button data-r="0">取消</button><button data-r="1" class="primary">確定</button></div>`, d => {
        const done = ok => { const v = $('#pp', d).value; closeModal(); res(ok ? v : null); };
        d.querySelectorAll('[data-r]').forEach(b => b.onclick = () => done(b.dataset.r === '1'));
        $('#pp', d).onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) done(true); };
      });
    });
  }

  /* ---------- 建立 / 解鎖 ---------- */
  function authShell(inner) {
    return `<div class="auth">
      <aside class="auth-brand">
        <div class="logo"><img src="icons/icon-192.png" alt="">帳號密碼紀錄 <span class="pro">PRO</span></div>
        <h1>你的所有帳號密碼，<br><span>只有你打得開。</span></h1>
        <p class="lead">企業等級加密的密碼保管箱，電腦與手機即時同步。</p>
        <div class="feats">
          <div class="feat"><div class="fi">${I('shield')}</div><div><b>AES-256-GCM 端對端加密</b><small>主密碼經 60 萬次 PBKDF2 衍生金鑰，只在本機解密</small></div></div>
          <div class="feat"><div class="fi">${I('cloud')}</div><div><b>Google 雲端同步</b><small>雲端只存密文，多台裝置自動合併</small></div></div>
          <div class="feat"><div class="fi">${I('lock')}</div><div><b>自動上鎖・剪貼簿清除</b><small>閒置即上鎖，複製的密碼數秒後清除</small></div></div>
        </div>
        <div class="auth-foot">v${VERSION}${DESKTOP ? ' · Windows' : ' · Web'} · 零知識架構，沒有後門</div>
      </aside>
      <main class="auth-main"><div class="auth-card">${inner}</div></main>
    </div>`;
  }
  function renderSetup() {
    app.innerHTML = authShell(`
      <h2>建立密碼庫</h2>
      <div class="sub">設定一組主密碼，用來加密你所有的資料。</div>
      <div class="notice">${I('alert', 'sm')}<span>主密碼<b>忘記就無法復原</b>，系統沒有任何後門，請務必牢記。</span></div>
      <label class="f">主密碼（建議 12 字以上）</label>
      <input type="password" id="p1" autocomplete="new-password" autofocus>
      <div id="m1">${meter('')}</div>
      <label class="f">確認主密碼</label>
      <input type="password" id="p2" autocomplete="new-password">
      <div class="err" id="err"></div>
      <button class="primary block" id="go">${I('shield')}建立加密密碼庫</button>
      <div class="auth-alt">
        <button id="fromcloud">${I('cloud')}已在別台裝置使用？從 Google 雲端下載</button>
        <button id="restore" class="ghost">${I('upload')}從備份檔（.pwvault）還原</button>
      </div>`);
    $('#fromcloud').onclick = e => { e.preventDefault(); cloudDialog(true); };
    const p1 = $('#p1'), p2 = $('#p2');
    p1.oninput = () => { $('#m1').innerHTML = meter(p1.value); };
    const go = async () => {
      if (p1.value.length < 6) return $('#err').textContent = '主密碼至少 6 個字';
      if (p1.value !== p2.value) return $('#err').textContent = '兩次輸入不一致';
      $('#go').disabled = true; $('#err').textContent = '';
      await createVault(p1.value);
    };
    $('#go').onclick = go;
    p2.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) go(); };
    $('#restore').onclick = e => { e.preventDefault(); pickFile(restoreFromFile); };
  }
  async function createVault(pw) {
    S.session = await PV.newSession(pw);
    S.data = defaults({ createdAt: Date.now() });
    await persist();
    S.lastAct = Date.now();
    renderMain();
    const pc = S.pendingCloud;
    if (pc) {
      S.pendingCloud = null;
      connectCloud(pc.url, pc.key).then(() => toast('已建立並連上 Google 雲端', 4000)).catch(e => toast('連線 Google 失敗：' + e.message, 6000));
    }
  }
  async function restoreFromFile(text) {
    if (!PV.isVaultText(text)) return toast('這不是本系統的備份檔（.pwvault）');
    const cur = await Store.load();
    if (cur && !(await confirmBox('還原備份', '還原會<b>取代目前的密碼庫</b>，確定嗎？', '取代', true))) return;
    await Store.save(text);
    toast('已還原，請用該備份的主密碼解鎖');
    renderUnlock();
  }

  function renderUnlock() {
    app.innerHTML = authShell(`
      <h2>歡迎回來</h2>
      <div class="sub">密碼庫已上鎖，請輸入主密碼解鎖。</div>
      <label class="f">主密碼</label>
      <div class="row"><div class="input-icon">${I('key', 'sm')}<input type="password" id="pw" autocomplete="current-password" autofocus></div>
        <button class="icon" id="eye" title="顯示/隱藏">${I('eye')}</button></div>
      <div class="err" id="err"></div>
      <button class="primary block" id="go">${I('lock')}解鎖</button>
      <div class="auth-alt">
        <button id="restore" class="ghost">${I('upload')}從備份檔還原</button>
      </div>`);
    const pw = $('#pw');
    $('#eye').onclick = () => { pw.type = pw.type === 'password' ? 'text' : 'password'; pw.focus(); };
    const go = async () => {
      if (!pw.value) return;
      $('#go').disabled = true; $('#err').textContent = '解鎖中…';
      const r = await unlock(pw.value);
      if (r === true) return;
      $('#err').textContent = r;
      setTimeout(() => { const g = $('#go'); if (g) g.disabled = false; pw.select(); }, Math.min(8000, 400 * 2 ** Math.max(0, S.fails - 2)));
    };
    $('#go').onclick = go;
    pw.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) go(); };
    $('#restore').onclick = e => { e.preventDefault(); pickFile(restoreFromFile); };
    setTimeout(() => pw.focus(), 50);
  }
  async function unlock(pw) {
    const text = await Store.load();
    if (!text) { renderSetup(); return true; }
    try {
      const r = await PV.open(text, pw);
      S.session = r.session; S.data = defaults(r.data); S.fails = 0; S.lastAct = Date.now();
      S.v.edit = null; S.v.showPw = false;
      renderMain();
      if (Cloud.cfg) syncNow();
      return true;
    } catch (e) {
      S.fails++;
      return e.message === 'BAD_PASSWORD' ? `主密碼錯誤（第 ${S.fails} 次）` : '密碼庫檔案損壞：' + e.message;
    }
  }
  function lock(reason) {
    if (!S.session) return;
    flushOnLock();
    S.session = null; S.data = null; S.lastSealed = null; S.v.edit = null; S.v.sel = null; S.v.q = '';
    closeModal();
    renderUnlock();
    if (reason) toast(reason);
  }

  /* ---------- 篩選 ---------- */
  function stats() {
    const es = S.data.entries, cats = {}, tags = {}, pwCount = {};
    let weak = 0, reused = 0, fav = 0;
    for (const e of es) {
      if (e.category) cats[e.category] = (cats[e.category] || 0) + 1;
      for (const t of e.tags || []) tags[t] = (tags[t] || 0) + 1;
      if (e.password) pwCount[e.password] = (pwCount[e.password] || 0) + 1;
      if (e.fav) fav++;
    }
    for (const e of es) {
      if (e.password && PV.strength(e.password).score <= 1) weak++;
      if (e.password && pwCount[e.password] > 1) reused++;
    }
    return { cats, tags, pwCount, weak, reused, fav, nocat: es.filter(e => !e.category).length };
  }
  function filtered(st) {
    const f = S.v.filter, q = S.v.q.trim().toLowerCase();
    let es = S.data.entries.filter(e => {
      if (f === 'fav') return e.fav;
      if (f === 'nocat') return !e.category;
      if (f === 'weak') return e.password && PV.strength(e.password).score <= 1;
      if (f === 'reused') return e.password && st.pwCount[e.password] > 1;
      if (f.startsWith('cat:')) return e.category === f.slice(4);
      if (f.startsWith('tag:')) return (e.tags || []).includes(f.slice(4));
      return true;
    });
    if (q) {
      const words = q.split(/\s+/);
      es = es.filter(e => {
        const hay = [e.title, e.url, e.username, e.notes, e.category, (e.tags || []).join(' ')].join('\n').toLowerCase();
        return words.every(w => hay.includes(w));
      });
    }
    const cmp = S.v.sort === 'recent' ? (a, b) => b.updatedAt - a.updatedAt
      : (a, b) => (b.fav - a.fav) || a.title.localeCompare(b.title, 'zh-Hant');
    if (f === 'reused') return es.sort((a, b) => a.password.localeCompare(b.password) || cmp(a, b));
    return es.sort(cmp);
  }

  /* ---------- 主畫面 ---------- */
  function renderMain() {
    app.innerHTML = `<div class="shell" id="shell">
      <nav class="side" id="side"></nav>
      <section class="list">
        <div class="top">
          <button class="icon ghost menu-btn" data-act="menu" title="選單">${I('menu')}</button>
          <div class="input-icon">${I('search', 'sm')}<input type="search" id="q" placeholder="搜尋名稱、帳號、網址…" value="${esc(S.v.q)}" autocomplete="off"></div>
          <button class="primary" data-act="new" title="新增（Ctrl+N）">${I('plus')}<span>新增</span></button>
        </div>
        <div class="bar"><span id="lcount"></span>
          <select id="sort" title="排序"><option value="name">依名稱</option><option value="recent">最近修改</option></select></div>
        <div class="items" id="items"></div>
      </section>
      <section class="detail" id="detail"></section>
    </div>`;
    $('#q').oninput = e => { S.v.q = e.target.value; renderList(); };
    $('#sort').value = S.v.sort;
    $('#sort').onchange = e => { S.v.sort = e.target.value; renderList(); };
    renderAll();
  }
  function renderAll() { const st = stats(); renderSide(st); renderList(st); renderDetail(st); layoutClass(); }
  function layoutClass() {
    const sh = $('#shell'); if (!sh) return;
    sh.classList.toggle('show-detail', !!(S.v.sel || S.v.edit));
    sh.classList.toggle('side-open', S.v.sideOpen);
  }
  function renderSide(st) {
    const f = S.v.filter, n = S.data.entries.length;
    const a = (key, icon, label, cnt, cls) => `<a data-f="${esc(key)}" class="${f === key ? 'on' : ''} ${cls || ''}">${I(icon)}<span class="lbl">${label}</span><span class="n">${cnt}</span></a>`;
    const cats = Object.keys(st.cats).sort((x, y) => x.localeCompare(y, 'zh-Hant'));
    const tags = Object.keys(st.tags).sort((x, y) => x.localeCompare(y, 'zh-Hant'));
    $('#side').innerHTML = `<div class="logo"><img src="icons/icon-192.png" alt=""><span>帳號密碼紀錄</span><span class="pro">PRO</span></div>
      <div class="nav">${a('all', 'all', '所有項目', n)}${a('fav', 'star', '我的最愛', st.fav)}
      <h4>分類</h4>${cats.map(c => a('cat:' + c, 'folder', esc(c), st.cats[c])).join('')}${a('nocat', 'inbox', '未分類', st.nocat)}
      ${tags.length ? '<h4>標籤</h4>' + tags.map(t => a('tag:' + t, 'hash', esc(t), st.tags[t])).join('') : ''}
      <h4>安全中心</h4>${a('weak', 'alert', '弱密碼', st.weak, st.weak ? 'bad' : '')}${a('reused', 'repeat', '重複使用', st.reused, st.reused ? 'bad' : '')}</div>
      ${syncHtml()}
      <div class="tools">
        <a data-act="gen">${I('dice')}<span class="lbl">密碼產生器</span></a>
        <a data-act="settings">${I('sliders')}<span class="lbl">設定與備份</span></a>
        <a data-act="lock">${I('lock')}<span class="lbl">立即上鎖</span><kbd>Ctrl L</kbd></a>
      </div>`;
  }
  function renderList(st) {
    st = st || stats();
    const es = filtered(st), box = $('#items');
    if (!box) return;
    const lc = $('#lcount'); if (lc) lc.innerHTML = `<b>${es.length}</b> 個項目`;
    if (!es.length) {
      box.innerHTML = `<div class="empty"><div class="ei">${I(S.data.entries.length ? 'search' : 'key', 'lg')}</div>${S.data.entries.length ? '沒有符合的項目' : `<b style="color:var(--text)">還沒有任何帳號</b><br>
        <button class="primary" data-act="new" style="margin:14px 0">${I('plus')}新增第一筆</button><br>
        <span style="font-size:12.5px">或到「設定與備份」匯入瀏覽器匯出的 CSV</span>`}</div>`;
      return;
    }
    box.innerHTML = es.map(e => {
      const weak = e.password && PV.strength(e.password).score <= 1;
      return `<div class="item ${S.v.sel === e.id ? 'on' : ''}" data-id="${e.id}">
      ${avatar(e)}<div class="meta"><div class="t">${esc(e.title)}</div>
      <div class="s">${esc(e.username || PV.hostOf(e.url) || e.category || '')}</div></div>
      ${weak ? '<span class="flag" title="弱密碼"></span>' : ''}${e.fav ? `<span class="star">${I('star', 'sm')}</span>` : ''}</div>`;
    }).join('');
  }
  function cur() { return S.data.entries.find(e => e.id === S.v.sel); }
  function renderDetail(st) {
    const d = $('#detail'); if (!d) return;
    if (S.v.edit) return renderEdit(d);
    const e = cur();
    if (!e) return renderOverview(d, st || stats());
    const s = PV.strength(e.password), reused = e.password && S.data.entries.filter(x => x.password === e.password).length;
    const op = (act, icon, title) => `<button class="icon ghost" data-act="${act}" title="${title}">${I(icon)}</button>`;
    const fr = (icon, k, val, ops, cls) => `<div class="fr"><div class="k">${I(icon, 'sm')}${k}</div><div class="val ${cls || ''}">${val}</div><div class="ops">${ops || ''}</div></div>`;
    const host = PV.hostOf(e.url);
    const login = [
      e.username && fr('user', '帳號', esc(e.username), op('cpu', 'copy', '複製帳號')),
      e.password && fr('key', '密碼', S.v.showPw ? esc(e.password) : '••••••••••••', op('eye', 'eye', '顯示/隱藏') + op('cpp', 'copy', '複製密碼'), 'mono'),
      e.url && fr('link', '網址', `<a href="#" data-act="open">${esc(e.url)}</a>`, op('open', 'ext', '開啟網站') + op('cpurl', 'copy', '複製網址'))
    ].filter(Boolean).join('');
    const more = [
      e.category && fr('folder', '分類', `<span class="chip" data-f="cat:${esc(e.category)}">${I('folder', 'sm')}${esc(e.category)}</span>`),
      (e.tags || []).length && fr('hash', '標籤', `<div class="chips">${e.tags.map(t => `<span class="chip" data-f="tag:${esc(t)}">#${esc(t)}</span>`).join('')}</div>`),
      e.notes && fr('note', '備註', esc(e.notes), op('cpn', 'copy', '複製備註'))
    ].filter(Boolean).join('');
    d.innerHTML = `<div class="dwrap">
      <div class="hero">
        <button class="icon ghost back" data-act="back" title="返回">${I('back')}</button>
        ${avatar(e)}
        <div class="ht"><h2>${esc(e.title)}</h2>
          <div class="hs">${host ? `<span>${esc(host)}</span>` : ''}${e.category ? `<span>· ${esc(e.category)}</span>` : ''}${e.password ? strengthBadge(s) : ''}</div></div>
        <div class="acts">
          <button class="icon ${e.fav ? 'fav-on' : ''}" data-act="fav" title="${e.fav ? '取消最愛' : '加入最愛'}">${I('star')}</button>
          <button data-act="dup" title="複製成新項目">${I('dup')}<span>複製</span></button>
          <button class="primary" data-act="edit">${I('edit')}<span>編輯</span></button>
        </div>
      </div>
      ${login ? `<div class="card"><h3>${I('key', 'sm')}登入資訊</h3>${login}
        ${e.password ? `<div class="cb">${meter(e.password)}${reused > 1 ? `<div class="sl s0">${I('repeat', 'sm')} 有 ${reused} 個項目使用相同密碼，建議更換</div>` : ''}</div>` : ''}</div>` : ''}
      ${more ? `<div class="card"><h3>${I('info', 'sm')}詳細資料</h3>${more}</div>` : ''}
      ${(e.history || []).length ? `<details class="card"><summary>${I('clock', 'sm')}舊密碼紀錄（${e.history.length}）</summary>
        ${e.history.map((h, i) => `<div class="hist-row"><span class="when">${fmtTime(h.at)} 停用</span><span class="val mono">${S.v.showPw ? esc(h.pw) : '••••••••••'}</span>
        <button class="icon ghost" data-act="cph" data-i="${i}" title="複製">${I('copy')}</button></div>`).join('')}</details>` : ''}
      <div class="metaline"><span>${I('plus', 'sm')}建立 ${fmtTime(e.createdAt)}</span><span>${I('edit', 'sm')}修改 ${fmtTime(e.updatedAt)}</span></div>
      <div class="dangerzone"><button class="danger" data-act="del">${I('trash')}刪除此項目</button></div>
    </div>`;
  }
  function renderOverview(d, st) {
    const n = S.data.entries.length, risky = new Set();
    for (const e of S.data.entries) if (e.password && (PV.strength(e.password).score <= 1 || st.pwCount[e.password] > 1)) risky.add(e.id);
    const score = n ? Math.round(100 * (n - risky.size) / n) : 100;
    const rc = score >= 80 ? 'var(--ok)' : score >= 50 ? 'var(--warn)' : 'var(--danger)';
    const kpi = (f, icon, label, v, cls) => `<div class="kpi ${cls || ''}" data-f="${f}"><div class="kh">${label}<span class="ic">${I(icon, 'sm')}</span></div><div class="kv">${v}</div></div>`;
    const c = Cloud.cfg;
    d.innerHTML = `<div class="dwrap overview">
      <h1>總覽</h1><div class="sub">密碼庫狀態一覽　·　閒置 ${S.data.settings.lockMin || '∞'} 分鐘自動上鎖</div>
      <div class="kpis">
        ${kpi('all', 'all', '帳號總數', n)}${kpi('fav', 'star', '我的最愛', st.fav, 'gold')}
        ${kpi('weak', 'alert', '弱密碼', st.weak, st.weak ? 'bad' : '')}${kpi('reused', 'repeat', '重複使用', st.reused, st.reused ? 'bad' : '')}
      </div>
      <div class="card"><div class="health">
        <div class="ring" style="--p:${score};--rc:${rc}"><div>${score}</div></div>
        <div><h4>密碼健康分數</h4><p>${risky.size ? `有 ${risky.size} 個項目使用弱密碼或重複密碼，點上方卡片可直接查看並更換。` : n ? '所有密碼都夠強且沒有重複使用，做得很好。' : '新增帳號後會在這裡顯示密碼健康狀況。'}</p></div>
      </div></div>
      <div class="card"><h3>${I('cloud', 'sm')}雲端同步</h3><div class="fr"><div class="k">${I('cloud', 'sm')}狀態</div>
        <div class="val">${c ? (S.sync.state === 'err' ? `<span class="badge bad">同步失敗</span> ${esc(S.sync.msg)}` : `<span class="badge ok">已連線</span>　版本 ${c.rev}${c.at ? '　·　' + fmtTime(c.at) : ''}`) : '<span class="badge warn">未連線</span>　資料只存在這台裝置'}</div>
        <div class="ops"><button data-act="${c ? 'syncnow' : 'cloudset'}">${I(c ? 'refresh' : 'cloud')}${c ? '立即同步' : '連線'}</button></div></div></div>
      <div class="card"><h3>${I('info', 'sm')}快速鍵</h3><div class="keys">
        <span><kbd>Ctrl N</kbd> 新增</span><span><kbd>Ctrl F</kbd> 搜尋</span><span><kbd>Ctrl G</kbd> 產生密碼</span><span><kbd>Ctrl S</kbd> 儲存</span><span><kbd>Ctrl L</kbd> 上鎖</span><span><kbd>Esc</kbd> 取消</span></div></div>
      <div class="metaline"><span>${I('shield', 'sm')}AES-256-GCM · PBKDF2 600,000</span><span>v${VERSION} PRO${DESKTOP ? ' · Windows' : ' · Web'}</span></div>
    </div>`;
  }

  function renderEdit(d) {
    const e = S.v.edit, cats = Object.keys(stats().cats).sort();
    const isNew = !S.data.entries.some(x => x.id === e.id);
    d.innerHTML = `<div class="dwrap">
      <div class="hero"><button class="icon ghost back" data-act="cancel" title="返回">${I('back')}</button>
        <div class="ht"><h2>${isNew ? '新增帳號' : '編輯：' + esc(e.title)}</h2><div class="hs">標示 * 為必填，其餘可留白</div></div></div>
      <div class="card"><h3>${I('key', 'sm')}登入資訊</h3><div class="cb"><div class="form-grid">
        <div class="full"><label class="f">名稱 *</label><input id="e_title" value="${esc(e.title)}" placeholder="例如：Google、公司 VPN、銀行" autocomplete="off"></div>
        <div><label class="f">帳號 / Email</label><input id="e_username" value="${esc(e.username)}" autocomplete="off"></div>
        <div><label class="f">網址</label><input id="e_url" value="${esc(e.url)}" placeholder="https://" autocomplete="off" inputmode="url"></div>
        <div class="full"><label class="f">密碼</label>
          <div class="row"><input id="e_password" type="${S.v.showPw ? 'text' : 'password'}" class="mono" value="${esc(e.password)}" autocomplete="new-password">
            <button class="icon" data-act="eye2" title="顯示/隱藏">${I('eye')}</button>
            <button class="icon" data-act="quickgen" title="直接產生一組強密碼">${I('dice')}</button>
            <button class="icon" data-act="gen2" title="產生器設定">${I('sliders')}</button></div>
          <div id="e_meter">${meter(e.password)}</div></div>
      </div></div></div>
      <div class="card"><h3>${I('info', 'sm')}詳細資料</h3><div class="cb"><div class="form-grid">
        <div><label class="f">分類</label><input id="e_category" value="${esc(e.category)}" list="catlist" placeholder="例如：工作、銀行、購物" autocomplete="off"></div>
        <datalist id="catlist">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <div><label class="f">標籤（逗號分隔）</label><input id="e_tags" value="${esc((e.tags || []).join(', '))}" autocomplete="off"></div>
        <div class="full"><label class="f">備註</label><textarea id="e_notes" placeholder="安全提問、PIN、備用碼…">${esc(e.notes)}</textarea></div>
        <div class="full"><label class="check"><input type="checkbox" id="e_fav" ${e.fav ? 'checked' : ''}> 加入我的最愛</label></div>
      </div></div></div>
      <div class="formbar"><button data-act="cancel">取消</button><button class="primary" data-act="save">${I('check')}儲存<kbd style="background:rgba(255,255,255,.15);border-color:transparent;color:#fff">Ctrl S</kbd></button></div>
    </div>`;
    $('#e_password').oninput = ev => { $('#e_meter').innerHTML = meter(ev.target.value); };
    setTimeout(() => { const t = $('#e_title'); if (t && !t.value) t.focus(); }, 30);
  }
  function readEdit() {
    const e = S.v.edit; if (!e) return;
    for (const k of ['title', 'username', 'password', 'url', 'category', 'notes']) {
      const el = $('#e_' + k); if (el) e[k] = k === 'password' || k === 'notes' ? el.value : el.value.trim();
    }
    const t = $('#e_tags'); if (t) e.tags = [...new Set(t.value.split(/[,，;；]/).map(s => s.trim()).filter(Boolean))];
    const f = $('#e_fav'); if (f) e.fav = f.checked;
  }
  async function saveEdit() {
    readEdit();
    const e = S.v.edit;
    if (!e.title) { e.title = PV.hostOf(e.url) || e.username; }
    if (!e.title) { toast('請輸入名稱'); $('#e_title').focus(); return; }
    const old = S.data.entries.find(x => x.id === e.id);
    e.updatedAt = Date.now();
    if (old) {
      if (old.password && old.password !== e.password) e.history = [{ pw: old.password, at: Date.now() }].concat(old.history || []).slice(0, 10);
      Object.assign(old, e);
    } else S.data.entries.push(e);
    S.v.sel = e.id; S.v.edit = null; S.v.showPw = false;
    await persist();
    renderAll();
    toast('已儲存');
  }

  /* ---------- 密碼產生器 ---------- */
  function openGenerator(onUse) {
    const g = S.data.settings.gen;
    openModal(`${dh('dice', '密碼產生器')}
      <div class="gen-out mono" id="g_out"></div><div id="g_m"></div>
      <label class="f">長度　<b id="g_lv" style="color:var(--primary)">${g.length}</b></label>
      <div class="row"><input type="range" id="g_len" min="6" max="64" value="${g.length}"><input type="number" id="g_num" min="6" max="64" value="${g.length}" style="width:80px;flex:none"></div>
      <div class="grid2" style="margin-top:8px">
        <label class="check"><input type="checkbox" id="g_upper" ${g.upper ? 'checked' : ''}> 大寫 A-Z</label>
        <label class="check"><input type="checkbox" id="g_lower" ${g.lower ? 'checked' : ''}> 小寫 a-z</label>
        <label class="check"><input type="checkbox" id="g_digits" ${g.digits ? 'checked' : ''}> 數字 0-9</label>
        <label class="check"><input type="checkbox" id="g_symbols" ${g.symbols ? 'checked' : ''}> 符號 !@#$…</label>
        <label class="check"><input type="checkbox" id="g_noAmbig" ${g.noAmbig ? 'checked' : ''}> 排除易混淆 (I l 1 O 0)</label>
      </div>
      <div class="btns"><button id="g_re">${I('refresh')}重新產生</button><button id="g_cp">${I('copy')}複製</button>
        ${onUse ? '<button class="primary" id="g_use">使用這組密碼</button>' : '<button class="primary" id="g_close">關閉</button>'}</div>`, d => {
      let pw = '';
      const opts = () => {
        for (const k of ['upper', 'lower', 'digits', 'symbols', 'noAmbig']) g[k] = $('#g_' + k, d).checked;
        return g;
      };
      const make = () => { pw = PV.generate(opts()); $('#g_out', d).textContent = pw; $('#g_m', d).innerHTML = meter(pw); };
      const setLen = v => { g.length = Math.max(6, Math.min(64, v | 0 || 16)); $('#g_len', d).value = g.length; $('#g_num', d).value = g.length; $('#g_lv', d).textContent = g.length; make(); };
      $('#g_len', d).oninput = ev => setLen(ev.target.value);
      $('#g_num', d).onchange = ev => setLen(ev.target.value);
      d.querySelectorAll('input[type=checkbox]').forEach(c => c.onchange = make);
      $('#g_re', d).onclick = make;
      $('#g_cp', d).onclick = () => copy(pw, '密碼');
      const fin = () => { closeModal(); persist().catch(() => {}); };
      if (onUse) $('#g_use', d).onclick = () => { fin(); onUse(pw); };
      else $('#g_close', d).onclick = fin;
      make();
    });
  }
  function setEditPw(pw) {
    const el = $('#e_password'); if (!el) return;
    el.value = pw; el.type = 'text'; S.v.showPw = true;
    $('#e_meter').innerHTML = meter(pw);
  }

  /* ---------- 設定 / 備份 ---------- */
  async function openSettings() {
    const st = S.data.settings;
    let where = '本機瀏覽器（此網站的儲存空間）';
    if (DESKTOP) { try { where = (await S.api.info()).data_dir; } catch (e) { } }
    const opt = (vals, cur, unit) => vals.map(v => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v ? v + unit : '永不'}</option>`).join('');
    openModal(`${dh('sliders', '設定與備份')}
      <section><h4>${I('lock', 'sm')}安全性</h4>
        <div class="grid2">
          <div><label class="f">閒置自動上鎖</label><select id="s_lock">${opt([1, 3, 5, 10, 15, 30, 60, 0], st.lockMin, ' 分鐘')}</select></div>
          <div><label class="f">複製後清除剪貼簿</label><select id="s_clip">${opt([10, 20, 30, 60, 120, 0], st.clipSec, ' 秒')}</select></div>
        </div>
        <div style="margin-top:12px"><button id="s_chpw">${I('key')}變更主密碼</button></div></section>
      <section><h4>${I('cloud', 'sm')}Google 雲端同步 ${Cloud.cfg ? '<span class="badge ok">已連線</span>' : '<span class="badge warn">未連線</span>'}</h4>
        <div class="desc">存在你自己的 Google 試算表，上傳的只有加密後的密文，Google 看不到內容。</div>
        ${Cloud.cfg ? `<div class="desc" style="color:var(--text-2)">版本 ${Cloud.cfg.rev}${Cloud.cfg.at ? '　·　上次同步 ' + fmtTime(Cloud.cfg.at) : ''}</div>
          <div class="row" style="flex-wrap:wrap"><button id="s_sync">${I('refresh')}立即同步</button><button id="s_unlink" class="danger">中斷連線</button></div>`
        : `<button id="s_link" class="primary">${I('cloud')}連線 Google 雲端</button>`}</section>
      <section><h4>${I('shield', 'sm')}加密備份</h4>
        <div class="desc">備份檔（.pwvault）以目前的主密碼加密，可在電腦與手機之間互相匯入。</div>
        <div class="row" style="flex-wrap:wrap"><button id="s_exp">${I('download')}匯出加密備份</button><button id="s_imp">${I('upload')}匯入備份 / CSV</button></div></section>
      <section><h4>${I('file', 'sm')}CSV 匯出</h4>
        <div class="desc">支援 Chrome、Edge、Firefox、Bitwarden 格式。CSV 為未加密明文，用完請立即刪除。</div>
        <button id="s_csv" class="danger">${I('download')}匯出 CSV（明文）</button></section>
      <section><h4>${I('info', 'sm')}資料位置</h4><div class="desc" style="overflow-wrap:anywhere;margin:0">${esc(where)}${DESKTOP ? '<br>每天自動在 backups 資料夾保留一份加密備份（最多 30 份）' : '<br>清除瀏覽器網站資料會一併刪除，請定期匯出備份'}</div></section>
      <div class="btns"><button class="primary" id="s_ok">完成</button></div>`, d => {
      const saveOpts = () => { st.lockMin = +$('#s_lock', d).value; st.clipSec = +$('#s_clip', d).value; };
      $('#s_ok', d).onclick = async () => { saveOpts(); closeModal(); await persist(); renderDetail(); toast('設定已儲存'); };
      $('#s_chpw', d).onclick = () => { saveOpts(); changeMaster(); };
      const sl = $('#s_link', d); if (sl) sl.onclick = () => { saveOpts(); cloudDialog(false); };
      const ss = $('#s_sync', d); if (ss) ss.onclick = async () => { saveOpts(); closeModal(); await syncNow(); toast(S.sync.state === 'ok' ? '同步完成' : '同步失敗：' + S.sync.msg, 4000); };
      const su = $('#s_unlink', d); if (su) su.onclick = async () => {
        saveOpts();
        if (await confirmBox('中斷雲端連線', '這台裝置將不再同步。雲端和本機的資料都會保留。', '中斷')) { await disconnectCloud(); toast('已中斷連線'); }
      };
      $('#s_exp', d).onclick = () => { saveOpts(); exportBackup(); };
      $('#s_imp', d).onclick = () => { saveOpts(); closeModal(); pickFile(importFile); };
      $('#s_csv', d).onclick = () => { saveOpts(); exportCsv(); };
    });
  }
  // download=true：還沒有本機密碼庫，直接從雲端下載（新手機 / 新電腦）
  function cloudDialog(download) {
    const preset = (window.PV_CLOUD_URL || '').trim();
    openModal(`${dh('cloud', download ? '從 Google 雲端下載' : '連線 Google 雲端')}
      <div class="muted" style="font-size:13px">${download
        ? '輸入雲端網址和同步密碼，下載後再用主密碼解鎖。'
        : '第一次連線時輸入的同步密碼會成為這個雲端的同步密碼，其他裝置要輸入同一組。<br>同步密碼只用來存取雲端，主密碼仍然只有你知道。'}</div>
      <label class="f">雲端網址（Apps Script 網頁應用程式）</label>
      <input id="c_url" value="${esc(preset)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" inputmode="url">
      <label class="f">同步密碼</label><input id="c_key" type="password" autocomplete="off" ${preset ? 'autofocus' : ''}>
      <div id="c_err" style="color:var(--danger);min-height:1.4em;margin-top:6px"></div>
      <button id="c_first" class="primary hidden" style="width:100%">${I('plus')}這是第一台：建立新密碼庫並連上這個雲端</button>
      <div class="btns"><button id="c_no">取消</button><button class="primary" id="c_ok">${I(download ? 'download' : 'cloud')}${download ? '下載' : '連線並同步'}</button></div>`, d => {
      $('#c_no', d).onclick = closeModal;
      const go = async () => {
        const err = m => { $('#c_err', d).textContent = m; };
        const url = $('#c_url', d).value.trim(), key = $('#c_key', d).value;
        $('#c_ok', d).disabled = true; err(download ? '下載中…' : '連線中…');
        try {
          if (download) {
            if (!okCloudUrl(url)) throw new Error('網址格式不對');
            const cfg = { url, key, rev: 0, dirty: false };
            const l = await cloudCall({ a: 'load' }, cfg);
            if (!l.vault) throw Object.assign(new Error('雲端還沒有資料'), { empty: true });
            await Store.save(l.vault);
            cfg.rev = l.rev; cfg.at = Date.now(); Cloud.cfg = cfg; await Cloud.save();
            closeModal(); toast('已下載，請輸入主密碼解鎖', 4000); renderUnlock();
          } else {
            closeModal();
            await connectCloud(url, key);
            toast('已連線並同步完成', 4000);
          }
        } catch (e) {
          if (!download) return toast('連線失敗：' + e.message, 6000);
          $('#c_ok', d).disabled = false;
          if (e.empty || e.message === '雲端還沒設定同步密碼') {
            // 雲端是空的：這是第一台裝置，改成建立新密碼庫，建好後自動用這組同步密碼連線
            err('雲端還是空的，看起來這是第一台裝置。');
            const b = $('#c_first', d); b.classList.remove('hidden');
            b.onclick = () => {
              if ((key || '').length < 6) return err('同步密碼至少 6 個字');
              S.pendingCloud = { url, key };
              closeModal();
              const m = $('#err'); if (m) { m.style.color = 'var(--primary)'; m.textContent = '設定主密碼並按「建立」，完成後會自動連上 Google 雲端。'; }
              const p = $('#p1'); if (p) p.focus();
            };
          } else err(e.message);
        }
      };
      $('#c_ok', d).onclick = go;
      $('#c_key', d).onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) go(); };
    });
  }
  function changeMaster() {
    openModal(`${dh('key', '變更主密碼')}
      <label class="f">目前主密碼</label><input type="password" id="c0" autocomplete="current-password" autofocus>
      <label class="f">新主密碼</label><input type="password" id="c1" autocomplete="new-password"><div id="cm">${meter('')}</div>
      <label class="f">再輸入一次</label><input type="password" id="c2" autocomplete="new-password">
      <div class="err" id="cerr" style="color:var(--danger);min-height:1.4em;margin-top:6px"></div>
      <div class="btns"><button id="cno">取消</button><button class="primary" id="cok">變更</button></div>`, d => {
      $('#c1', d).oninput = ev => { $('#cm', d).innerHTML = meter(ev.target.value); };
      $('#cno', d).onclick = closeModal;
      $('#cok', d).onclick = async () => {
        const err = m => { $('#cerr', d).textContent = m; };
        const [c0, c1, c2] = ['#c0', '#c1', '#c2'].map(s => $(s, d).value);
        if (c1.length < 6) return err('新主密碼至少 6 個字');
        if (c1 !== c2) return err('兩次輸入不一致');
        $('#cok', d).disabled = true; err('驗證中…');
        const r = await changeMasterTo(c0, c1);
        if (r !== true) { $('#cok', d).disabled = false; return err(r); }
        closeModal(); toast('主密碼已變更，舊的備份檔仍需用舊密碼開啟', 5000);
      };
    });
  }
  async function changeMasterTo(oldPw, newPw) {
    try { await PV.open(await PV.seal(S.session, {}), oldPw); }
    catch (e) { return '目前主密碼不正確'; }
    S.session = await PV.newSession(newPw, S.session.iter);
    await persist();
    return true;
  }
  async function saveOut(name, text, mime) {
    if (DESKTOP) {
      const r = await S.api.save_file(name, text);
      if (r) toast('已存到 ' + r, 5000);
      return;
    }
    const blob = new Blob([text], { type: mime });
    const file = new File([blob], name, { type: mime });
    if (/iPhone|iPad|Android/i.test(navigator.userAgent) && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('已下載 ' + name);
  }
  async function exportBackup() {
    await saveOut(`帳號密碼備份-${ymd()}.pwvault`, await PV.seal(S.session, S.data), 'application/octet-stream');
  }
  async function exportCsv() {
    if (!(await confirmBox('匯出 CSV', 'CSV 是<b>沒有加密的明文</b>，任何人拿到檔案都看得到所有密碼。<br>用完請立即刪除。確定匯出？', '我了解，匯出', true))) return;
    await saveOut(`帳號密碼-${ymd()}.csv`, PV.toCSV(PV.entriesToRows(S.data.entries)), 'text/csv');
  }
  function pickFile(cb) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.pwvault,.json,.csv,text/csv,application/json';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try { await cb(await f.text(), f.name); } catch (e) { toast('讀取失敗：' + e.message, 5000); }
    };
    inp.click();
  }
  // 合併：加密備份依 id 取較新的；CSV 依「網站+帳號+密碼」略過重複
  async function mergeEntries(list, byId) {
    let added = 0, updated = 0, skipped = 0;
    const keys = new Set(S.data.entries.map(dupKey));
    for (const x of list) {
      const same = byId && S.data.entries.find(e => e.id === x.id);
      if (same) {
        if ((x.updatedAt || 0) > (same.updatedAt || 0)) { Object.assign(same, x); updated++; } else skipped++;
        continue;
      }
      if (keys.has(dupKey(x))) { skipped++; continue; }
      const e = newEntry(byId ? x : Object.assign({}, x, { id: undefined }));
      if (!e.id) e.id = PV.uid();
      S.data.entries.push(e); keys.add(dupKey(e)); added++;
    }
    await persist();
    return { added, updated, skipped };
  }
  async function importFile(text, name) {
    let r;
    if (PV.isVaultText(text)) {
      const pw = await promptPw('匯入加密備份', `輸入「${esc(name || '備份檔')}」的主密碼`);
      if (pw == null) return;
      let opened;
      try { opened = await PV.open(text, pw); } catch (e) { return toast(e.message === 'BAD_PASSWORD' ? '備份檔的主密碼錯誤' : '檔案損壞', 4000); }
      r = await mergeEntries(defaults(opened.data).entries, true);
    } else {
      const list = PV.rowsToEntries(PV.parseCSV(text));
      if (!list.length) return toast('CSV 裡沒有可匯入的資料', 4000);
      r = await mergeEntries(list, false);
    }
    S.v.filter = 'all'; renderAll();
    openModal(`${dh('check', '匯入完成')}<p>新增 <b>${r.added}</b> 筆${r.updated ? `、更新 ${r.updated} 筆` : ''}、略過重複 ${r.skipped} 筆。</p>
      ${/\.csv$/i.test(name || '') ? `<div class="notice">${I('alert', 'sm')}<span>請記得刪除剛才的 CSV 檔（它沒有加密）。</span></div>` : ''}
      <div class="btns"><button class="primary" id="ok" autofocus>好</button></div>`, d => { $('#ok', d).onclick = closeModal; });
    return r;
  }

  /* ---------- 事件 ---------- */
  app.addEventListener('click', async ev => {
    const fEl = ev.target.closest('[data-f]');
    if (fEl) { S.v.filter = fEl.dataset.f; S.v.sideOpen = false; S.v.sel = null; S.v.edit = null; renderAll(); return; }
    const it = ev.target.closest('.item[data-id]');
    if (it) { if (S.v.edit) readEdit(); S.v.sel = it.dataset.id; S.v.edit = null; S.v.showPw = false; renderAll(); return; }
    const b = ev.target.closest('[data-act]'); if (!b || !S.data) return;
    ev.preventDefault();
    const e = cur(), act = b.dataset.act;
    switch (act) {
      case 'menu': S.v.sideOpen = !S.v.sideOpen; layoutClass(); break;
      case 'new': S.v.edit = newEntry(S.v.filter.startsWith('cat:') ? { category: S.v.filter.slice(4) } : {}); S.v.showPw = false; S.v.sideOpen = false; renderAll(); break;
      case 'edit': S.v.edit = JSON.parse(JSON.stringify(e)); renderAll(); break;
      case 'dup': S.v.edit = newEntry(Object.assign(JSON.parse(JSON.stringify(e)), { id: PV.uid(), title: e.title + '（副本）', history: [], createdAt: Date.now() })); renderAll(); break;
      case 'cancel': S.v.edit = null; S.v.showPw = false; renderAll(); break;
      case 'save': await saveEdit(); break;
      case 'back': S.v.sel = null; renderAll(); break;
      case 'eye': S.v.showPw = !S.v.showPw; renderDetail(); break;
      case 'eye2': { const p = $('#e_password'); S.v.showPw = p.type === 'password'; p.type = S.v.showPw ? 'text' : 'password'; break; }
      case 'quickgen': setEditPw(PV.generate(S.data.settings.gen)); break;
      case 'gen2': openGenerator(setEditPw); break;
      case 'gen': openGenerator(); break;
      case 'cpu': copy(e.username, '帳號'); break;
      case 'cpp': copy(e.password, '密碼'); break;
      case 'cpurl': copy(e.url, '網址'); break;
      case 'cpn': copy(e.notes, '備註'); break;
      case 'cph': copy(e.history[+b.dataset.i].pw, '舊密碼'); break;
      case 'open': openUrl(e.url); break;
      case 'fav': e.fav = !e.fav; e.updatedAt = Date.now(); await persist(); renderAll(); break;
      case 'del':
        if (await confirmBox('刪除', `確定刪除「<b>${esc(e.title)}</b>」？刪除後無法復原。`, '刪除', true)) {
          S.data.entries = S.data.entries.filter(x => x.id !== e.id); S.v.sel = null;
          S.data.deleted[e.id] = Date.now();
          await persist(); renderAll(); toast('已刪除');
        }
        break;
      case 'settings': openSettings(); break;
      case 'cloudset': cloudDialog(false); break;
      case 'syncnow': syncNow(); break;
      case 'lock': lock(); break;
    }
  });
  document.addEventListener('keydown', ev => {
    S.lastAct = Date.now();
    if (!S.data) return;
    const k = ev.key.toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
    if (mod && k === 'l') { ev.preventDefault(); lock(); }
    else if (mod && k === 'f') { ev.preventDefault(); closeModal(); const q = $('#q'); if (q) { q.focus(); q.select(); } }
    else if (mod && k === 'n') { ev.preventDefault(); closeModal(); app.querySelector('[data-act=new]').click(); }
    else if (mod && k === 'g') { ev.preventDefault(); if (modal.classList.contains('hidden')) openGenerator(S.v.edit ? setEditPw : null); }
    else if (mod && k === 's' && S.v.edit) { ev.preventDefault(); saveEdit(); }
    else if (k === 'escape') {
      if (!modal.classList.contains('hidden')) closeModal();
      else if (S.v.edit) { S.v.edit = null; renderAll(); }
      else if (S.v.sideOpen) { S.v.sideOpen = false; layoutClass(); }
    }
  });
  for (const t of ['pointerdown', 'pointermove', 'wheel', 'touchstart']) document.addEventListener(t, () => { S.lastAct = Date.now(); }, { passive: true });
  function idleCheck() {
    if (!S.session) return;
    const m = S.data.settings.lockMin;
    if (m > 0 && Date.now() - S.lastAct > m * 60000) lock(`閒置 ${m} 分鐘，已自動上鎖`);
  }
  setInterval(idleCheck, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (S.session && Cloud.cfg && Cloud.cfg.dirty) syncNow(); return; }
    idleCheck();
    if (S.session && Cloud.cfg) syncNow();
  });
  // 每 30 秒檢查雲端有沒有別台裝置的新版本（只查版本號，很省流量）
  setInterval(() => { if (S.session && Cloud.cfg && !document.hidden && !SELFTEST) syncNow(); }, 30000);

  /* ---------- 自我測試 ---------- */
  async function selftest() {
    const R = { version: VERSION, desktop: DESKTOP, steps: [], ok: true };
    const step = (name, ok, info) => { R.steps.push({ name, ok: !!ok, info }); if (!ok) R.ok = false; };
    try {
      const pw = PV.generate({ length: 24 });
      step('產生器長度與字元組', pw.length === 24 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw), pw.length);
      step('強度評估', PV.strength('123456').score === 0 && PV.strength(pw).score === 4);
      const before = await Store.load();
      step('起始狀態', true, before ? '已有密碼庫（測試資料夾不該有）' : '空白');
      await createVault('Test-主密碼-123');
      step('建立密碼庫', !!S.session && !!$('#items'));
      S.v.edit = newEntry({ title: 'Google', username: 'me@gmail.com', password: 'Old-Pass-1', url: 'accounts.google.com', category: '個人', tags: ['email'] });
      renderAll(); await saveEdit();
      const g = S.data.entries[0];
      S.v.edit = JSON.parse(JSON.stringify(g)); renderAll(); $('#e_password').value = 'New-Pass-2!'; await saveEdit();
      step('編輯保留舊密碼紀錄', g.password === 'New-Pass-2!' && g.history.length === 1 && g.history[0].pw === 'Old-Pass-1');
      const csv = 'name,url,username,password,note\r\nFacebook,https://www.facebook.com/,bob,123456,\r\n銀行,https://bank.example.tw,u1,"Xq,7""Lm-Bank#9z",網銀\r\nGoogle,https://accounts.google.com/,me@gmail.com,New-Pass-2!,\r\n';
      const r1 = await importFile(csv, 'test.csv'); closeModal();
      step('CSV 匯入與去重', r1.added === 2 && r1.skipped === 1, r1);
      step('特殊字元密碼', S.data.entries.some(e => e.password === 'Xq,7"Lm-Bank#9z'));
      const st = stats();
      step('安全檢查（弱密碼）', st.weak === 1, st.weak);
      S.v.q = '網銀'; step('搜尋備註', filtered(st).length === 1); S.v.q = '';
      const file = await Store.load();
      step('存檔不含明文', file && !file.includes('New-Pass-2') && !file.includes('facebook'));
      const backup = await PV.seal(S.session, S.data);
      lock();
      step('上鎖清除記憶體', S.data === null && !!$('#pw'));
      step('錯誤主密碼被拒', (await unlock('wrong')) !== true);
      step('正確主密碼解鎖', (await unlock('Test-主密碼-123')) === true && S.data.entries.length === 3);
      step('變更主密碼', (await changeMasterTo('Test-主密碼-123', 'New-主密碼-456')) === true);
      lock();
      step('新主密碼解鎖', (await unlock('New-主密碼-456')) === true);
      S.data.entries = S.data.entries.slice(0, 1);
      await persist();
      const ob = await PV.open(backup, 'Test-主密碼-123');
      const r2 = await mergeEntries(defaults(ob.data).entries, true); closeModal();
      step('匯入加密備份合併', r2.added === 2 && S.data.entries.length === 3, r2);
      if (DESKTOP) {
        await S.api.copy('clip-test', 2);
        step('剪貼簿複製', (await S.api.clip_text()) === 'clip-test');
        await new Promise(r => setTimeout(r, 3200));
        step('剪貼簿自動清除', (await S.api.clip_text()) === '');
      }
      const curl = qs.get('cloud');
      if (curl) {
        // 模擬兩台裝置：B 直接改雲端（新增一筆、刪一筆），A 同時新增一筆，同步後兩邊都要齊
        await connectCloud(curl, 'sync-key-123');
        let bad = false;
        try { await cloudCall({ a: 'rev' }, { url: curl, key: 'wrong-key' }); } catch (e) { bad = e.message === '同步密碼錯誤'; }
        step('雲端連線並上傳', S.sync.state === 'ok' && Cloud.cfg.rev >= 1 && !Cloud.cfg.dirty, Cloud.cfg.rev);
        step('雲端同步密碼錯誤被拒', bad);
        const l1 = await cloudCall({ a: 'load' });
        const b = await PV.openWith(l1.vault, S.session);
        const victim = b.entries.find(e => e.title === 'Facebook');
        b.entries = b.entries.filter(e => e !== victim);
        b.deleted = Object.assign(b.deleted || {}, { [victim.id]: Date.now() });
        b.entries.push(newEntry({ title: 'FromB', password: 'b-Pass-778899' }));
        const sb = await cloudCall({ a: 'save', baseRev: l1.rev, vault: await PV.seal(S.session, b) });
        S.data.entries.push(newEntry({ title: 'FromA', password: 'a-Pass-112233' }));
        await persist();
        await syncNow();
        const titles = S.data.entries.map(e => e.title).sort().join(',');
        step('衝突合併（本機）', sb.ok && titles.includes('FromA') && titles.includes('FromB') && !titles.includes('Facebook'), titles);
        const l2 = await cloudCall({ a: 'load' });
        const rt = (await PV.openWith(l2.vault, S.session)).entries.map(e => e.title).sort().join(',');
        step('衝突合併（雲端）', rt === titles && !Cloud.cfg.dirty && l2.rev === Cloud.cfg.rev, l2.rev);
        step('雲端只有密文', !l2.vault.includes('FromA') && !l2.vault.includes('Pass'));
        const ok = await PV.open(l2.vault, 'New-主密碼-456');
        step('雲端可用主密碼解開', ok.data.entries.length === S.data.entries.length);
      }
      S.data.settings.lockMin = 1; S.lastAct = Date.now() - 61000; idleCheck();
      step('閒置自動上鎖', S.session === null);
      step('最終存檔可用新密碼開啟', (await PV.open(await Store.load(), 'New-主密碼-456')).data.entries.length === (curl ? 4 : 3));
    } catch (e) { step('例外', false, String(e && e.stack || e)); }
    window.__selftest = R;
    if (DESKTOP) await S.api.selftest_done(JSON.stringify(R));
    else console.log('SELFTEST', JSON.stringify(R));
  }

  /* ---------- 啟動 ---------- */
  async function boot() {
    if (DESKTOP) S.api = await apiReady();
    if (!DESKTOP && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
    if (!window.crypto || !crypto.subtle) {
      app.innerHTML = '<div class="center"><div class="lock-card">此瀏覽器不支援加密功能（需 https 或本機網址）。</div></div>';
      return;
    }
    await Cloud.load();
    if (SELFTEST) return selftest();
    (await Store.load()) ? renderUnlock() : renderSetup();
  }
  boot();
})();
