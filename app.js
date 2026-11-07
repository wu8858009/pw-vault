/* 帳號密碼紀錄 PRO — 介面（PWA 與桌面 exe 共用） */
(function () {
  'use strict';
  const VERSION = '1.3.0';
  const qs = new URLSearchParams(location.search);
  const DESKTOP = qs.has('desktop');
  const SELFTEST = qs.has('selftest');
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const app = $('#app'), modal = $('#modal');
  const TRASH_DAYS = 30, ATT_MAX = 10 * 1024 * 1024;

  const S = {
    session: null, data: null, api: null, lastAct: Date.now(), fails: 0,
    vid: 'default', vaults: [], dev: null,
    v: { filter: 'all', q: '', sel: null, edit: null, sort: 'name', showPw: false, sideOpen: false, multi: null }
  };

  /* ================= 儲存層 ================= */
  function apiReady() {
    return new Promise(res => {
      if (window.pywebview && window.pywebview.api) return res(window.pywebview.api);
      window.addEventListener('pywebviewready', () => res(window.pywebview.api), { once: true });
    });
  }
  const MEM = SELFTEST && !DESKTOP; // 瀏覽器自我測試：全部放記憶體，不碰真資料
  const mem = { kv: {}, store: {}, cloud: {}, att: {} };
  const lsKey = (base, vid) => (vid && vid !== 'default' ? base + '.' + vid : base);
  // 裝置設定（保管庫清單、裝置名稱、生物辨識…），不跟著同步
  const Local = {
    async get(k) {
      if (MEM) return k in mem.kv ? mem.kv[k] : null;
      if (DESKTOP) { const v = await S.api.kv_get(k); return v === undefined ? null : v; }
      try { const t = localStorage.getItem('pwvault.kv.' + k); return t == null ? null : JSON.parse(t); } catch (e) { return null; }
    },
    async set(k, v) {
      if (MEM) { if (v == null) delete mem.kv[k]; else mem.kv[k] = v; return; }
      if (DESKTOP) return S.api.kv_set(k, v);
      try { if (v == null) localStorage.removeItem('pwvault.kv.' + k); else localStorage.setItem('pwvault.kv.' + k, JSON.stringify(v)); } catch (e) { }
    }
  };
  const Store = {
    async load(vid = S.vid) {
      if (MEM) return mem.store[vid] || null;
      if (DESKTOP) return await S.api.load_vault(vid);
      try { return localStorage.getItem(lsKey('pwvault.v1', vid)); } catch (e) { return null; }
    },
    async save(text, vid = S.vid) {
      if (MEM) { mem.store[vid] = text; return; }
      if (DESKTOP) { const r = await S.api.save_vault(text, vid); if (r !== true) throw new Error(r || '寫入失敗'); return; }
      localStorage.setItem(lsKey('pwvault.v1', vid), text);
    },
    async remove(vid) {
      if (MEM) { delete mem.store[vid]; delete mem.cloud[vid]; return; }
      if (DESKTOP) return S.api.delete_vault(vid);
      localStorage.removeItem(lsKey('pwvault.v1', vid)); localStorage.removeItem(lsKey('pwvault.cloud', vid));
      try { await idbDo('readwrite', st => { st.openCursor().onsuccess = ev => { const c = ev.target.result; if (c) { if (String(c.key).startsWith(vid + ':')) c.delete(); c.continue(); } }; }); } catch (e) { }
    }
  };
  // 加密附件的本機快取：瀏覽器用 IndexedDB、桌面版存檔案
  let idbP = null;
  function idbOpen() {
    return idbP || (idbP = new Promise((res, rej) => {
      const r = indexedDB.open('pwvault-att', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('b');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  }
  async function idbDo(mode, fn) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction('b', mode), rq = fn(tx.objectStore('b'));
      tx.oncomplete = () => res(rq && rq.result); tx.onerror = () => rej(tx.error);
    });
  }
  const AttStore = {
    async put(vid, id, t) {
      if (MEM) { mem.att[vid + ':' + id] = t; return; }
      if (DESKTOP) return S.api.att_put(vid, id, t);
      return idbDo('readwrite', st => st.put(t, vid + ':' + id));
    },
    async get(vid, id) {
      if (MEM) return mem.att[vid + ':' + id] || null;
      if (DESKTOP) return await S.api.att_get(vid, id);
      return (await idbDo('readonly', st => st.get(vid + ':' + id))) || null;
    },
    async del(vid, id) {
      if (MEM) { delete mem.att[vid + ':' + id]; return; }
      if (DESKTOP) return S.api.att_del(vid, id);
      return idbDo('readwrite', st => st.delete(vid + ':' + id));
    }
  };

  async function persistLocal() {
    try { const t = await PV.seal(S.session, S.data); await Store.save(t); S.lastSealed = t; }
    catch (e) { toast('⚠ 儲存失敗：' + e.message, 6000); throw e; }
  }
  let soonT = 0;
  async function persist() {
    clearTimeout(soonT); soonT = 0;
    await persistLocal();
    if (Cloud.cfg) { Cloud.cfg.dirty = true; await Cloud.save(); scheduleSync(800); }
  }
  // 稽核紀錄、使用次數這類小變更：合併成一次存檔
  function persistSoon() { clearTimeout(soonT); soonT = setTimeout(() => { soonT = 0; persist().catch(() => {}); }, 1500); }

  /* ================= Google 雲端同步（只傳密文） ================= */
  const Cloud = {
    cfg: null,
    async load(vid = S.vid) {
      let t = null;
      if (MEM) t = mem.cloud[vid] || null;
      else if (DESKTOP) t = await S.api.get_cloud(vid);
      else { try { t = localStorage.getItem(lsKey('pwvault.cloud', vid)); } catch (e) { } }
      try { this.cfg = t ? JSON.parse(t) : null; } catch (e) { this.cfg = null; }
      return this.cfg;
    },
    async save(vid = S.vid, cfg = this.cfg) {
      const t = cfg ? JSON.stringify(cfg) : '';
      if (MEM) mem.cloud[vid] = t;
      else if (DESKTOP) await S.api.set_cloud(t, vid);
      else if (t) localStorage.setItem(lsKey('pwvault.cloud', vid), t); else localStorage.removeItem(lsKey('pwvault.cloud', vid));
    }
  };
  function okCloudUrl(u) {
    return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u) || /^http:\/\/(127\.0\.0\.1|localhost):\d+\/[\w/-]*$/.test(u);
  }
  async function cloudCall(body, cfg) {
    cfg = cfg || Cloud.cfg;
    let r;
    const payload = Object.assign({ key: cfg.key }, cfg.ns ? { ns: cfg.ns } : {}, body);
    try {
      r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload), cache: 'no-store', redirect: 'follow' });
    } catch (e) { throw new Error('連不上 Google（網路中斷？）'); }
    if (!r.ok) throw new Error('雲端錯誤 HTTP ' + r.status);
    let j;
    try { j = await r.json(); } catch (e) { throw new Error('雲端回應格式不對（網址錯誤或尚未授權部署）'); }
    if (!j.ok && j.err !== 'CONFLICT' && j.err !== 'NO_ATT') {
      throw new Error({ BAD_KEY: '同步密碼錯誤', NOT_SETUP: '雲端還沒設定同步密碼', NOT_VAULT: '資料格式錯誤', TOO_LARGE: '附件太大', BAD_NS: '保管庫代碼錯誤' }[j.err] || j.err);
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
    const [cls, txt] = s.state === 'busy' ? ['busy', '同步中…'] : s.state === 'err' ? ['bad', '同步失敗'] : (c.dirty || (c.attq || []).length) ? ['wait', '等待上傳'] : ['', `已同步 ${t}`];
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
      await flushAtt(c);
      c.at = Date.now(); await Cloud.save();
      setSync('ok');
    } catch (e) { setSync('err', e.message); }
    finally {
      syncBusy = false;
      if (syncAgain) { syncAgain = false; scheduleSync(300); }
    }
  }
  // 附件另外上傳（不塞進密碼庫，避免每次同步都傳大檔）
  async function flushAtt(c) {
    for (const id of [...(c.attq || [])]) {
      const t = await AttStore.get(S.vid, id);
      if (t) await cloudCall({ a: 'att_put', id, data: t }, c);
      c.attq = (c.attq || []).filter(x => x !== id); await Cloud.save();
    }
    for (const id of [...(c.attdel || [])]) {
      await cloudCall({ a: 'att_del', id }, c);
      c.attdel = (c.attdel || []).filter(x => x !== id); await Cloud.save();
    }
  }
  // 上鎖時還沒傳上去的變更：直接送最後一次存檔的密文（衝突就留到下次解鎖再合併）
  function flushOnLock(c, t, vid) {
    if (!c || !c.dirty || !t || syncBusy) return;
    cloudCall({ a: 'save', baseRev: c.rev, vault: t }, c).then(async s => {
      if (s.ok) { c.rev = s.rev; c.dirty = false; c.at = Date.now(); await Cloud.save(vid, c); }
    }).catch(() => {});
  }
  async function connectCloud(url, key) {
    url = (url || '').trim();
    if (!okCloudUrl(url)) throw new Error('網址格式不對，應該是 https://script.google.com/macros/s/…/exec');
    if ((key || '').length < 6) throw new Error('同步密碼至少 6 個字');
    const cfg = { url, key, rev: 0, dirty: true, attq: allAttIds() };
    if (S.vid !== 'default') cfg.ns = S.vid;
    await cloudCall({ a: 'ping' }, cfg);
    Cloud.cfg = cfg; await Cloud.save();
    log('cloud');
    await syncNow();
    if (S.sync.state === 'err') throw new Error(S.sync.msg);
  }
  async function disconnectCloud() {
    Cloud.cfg = null; await Cloud.save(); setSync('off');
  }

  /* ================= 小工具 ================= */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  let toastT;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    t.classList.toggle('bad', /失敗|錯誤|⚠|不對|無法|不支援/.test(msg));
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
    restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 6.5V12l3.5 2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 16v-4M12 8h.01"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20M6 15h4"/>',
    id: '<rect x="2" y="4" width="20" height="16" rx="2.5"/><circle cx="8.5" cy="11" r="2.5"/><path d="M5 16.5c.6-1.6 2-2.5 3.5-2.5s2.9.9 3.5 2.5M15 9h4M15 13h4"/>',
    wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/>',
    license: '<path d="M4 4h16v12H4z"/><path d="M8 20h8M12 16v4M8 8h8M8 12h5"/>',
    clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    box: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
    boxck: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12 3 3 5-6"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    finger: '<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4M14 13.12c0 2.38 0 6.38-1 8.88M17.29 21.02c.12-.6.43-2.3.5-3.02M2 12a10 10 0 0 1 18-6M2 16h.01M21.8 16c.2-2 .131-5.354 0-6M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2M8.65 22c.21-.66.45-1.32.57-2M9 6.8a6 6 0 0 1 9 5.2v2"/>',
    vault: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="4"/><path d="M12 8v1M12 15v1M8 12h1M15 12h1M7 7h.01M17 7h.01"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 16v-5M12 16V8M17 16v-8"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    type: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
    kbd: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'
  };
  function I(name, cls) { return `<svg class="i ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`; }
  function hue(s) { let h = 0; for (const c of s || '?') h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function avatar(e) {
    const h = hue(e.title), bg = `background:linear-gradient(135deg,hsl(${h} 62% 52%),hsl(${(h + 28) % 360} 58% 40%))`;
    if (e.type && e.type !== 'login') return `<div class="av" style="${bg}">${I(TYPES[e.type].icon)}</div>`;
    const ch = ([...(e.title || '?').trim()][0] || '?').toUpperCase();
    return `<div class="av" style="${bg}">${esc(ch)}</div>`;
  }
  function fmtTime(t) {
    if (!t) return '';
    const d = new Date(t), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function ago(t) {
    if (!t) return '從未';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return '剛剛'; if (s < 3600) return Math.floor(s / 60) + ' 分鐘前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小時前'; if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
    if (s < 86400 * 365) return Math.floor(s / 86400 / 30) + ' 個月前'; return Math.floor(s / 86400 / 365) + ' 年前';
  }
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function ymd() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; }
  function normUrl(u) { u = (u || '').trim(); if (!u) return ''; return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : 'https://' + u; }
  function meter(pw) {
    const s = PV.strength(pw);
    return `<div class="meter s${s.score} ${pw ? '' : 'empty'}"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="sl">${pw ? `強度 <b class="s${s.score}">${s.label}</b>　約 ${s.bits} bits` : ''}</div>`;
  }
  function strengthBadge(s) { return `<span class="badge ${s.score >= 3 ? 'ok' : s.score === 2 ? 'warn' : 'bad'}">${I('shield', 'sm')}${s.label}</span>`; }
  function dh(icon, title, bad) { return `<h3><span class="hi ${bad ? 'bad' : ''}">${I(icon)}</span>${esc(title)}</h3>`; }
  function defaults(d) {
    d = d || {};
    d.v = 1; d.entries = d.entries || []; d.deleted = d.deleted || {};
    d.audit = d.audit || []; d.usage = d.usage || {}; d.breach = d.breach || {}; d.deks = d.deks || {};
    d.settings = Object.assign({ lockMin: 5, clipSec: 20 }, d.settings || {});
    d.settings.gen = Object.assign({ length: 16, upper: true, lower: true, digits: true, symbols: true, noAmbig: true }, d.settings.gen || {});
    for (const e of d.entries) { e.type = e.type || 'login'; e.data = e.data || {}; e.fields = e.fields || []; e.att = e.att || []; e.tags = e.tags || []; }
    return d;
  }
  function dupKey(e) { return [(PV.hostOf(e.url) || e.title || '').toLowerCase(), e.username || '', e.password || ''].join('\n'); }
  function newEntry(o) {
    const now = Date.now();
    return Object.assign({ id: PV.uid(), type: 'login', title: '', url: '', username: '', password: '', notes: '', category: '', tags: [], fav: false,
      history: [], data: {}, fields: [], att: [], createdAt: now, updatedAt: now, pwAt: now }, o);
  }

  /* ================= 項目類型 ================= */
  const TYPES = {
    login: { name: '登入帳號', icon: 'key', fields: [] },
    card: { name: '信用卡', icon: 'card', fields: [
      { k: 'holder', l: '持卡人' }, { k: 'number', l: '卡號', secret: 1, mono: 1, ph: '0000 0000 0000 0000' },
      { k: 'exp', l: '有效期限', ph: 'MM/YY' }, { k: 'cvv', l: '安全碼 CVV', secret: 1, mono: 1 },
      { k: 'pin', l: 'PIN 碼', secret: 1, mono: 1 }, { k: 'bank', l: '發卡銀行' }] },
    identity: { name: '身分證件', icon: 'id', fields: [
      { k: 'fullname', l: '姓名' }, { k: 'doctype', l: '證件類型', ph: '身分證／護照／駕照／健保卡' },
      { k: 'docno', l: '證件號碼', secret: 1, mono: 1 }, { k: 'birth', l: '出生日期', ph: 'YYYY/MM/DD' },
      { k: 'issued', l: '發證日期' }, { k: 'expiry', l: '到期日' }, { k: 'phone', l: '電話' }, { k: 'address', l: '地址', full: 1 }] },
    wifi: { name: 'Wi-Fi', icon: 'wifi', fields: [
      { k: 'ssid', l: '網路名稱 SSID' }, { k: 'wpass', l: 'Wi-Fi 密碼', secret: 1, mono: 1 }, { k: 'security', l: '加密方式', ph: 'WPA2／WPA3' }] },
    license: { name: '軟體授權', icon: 'license', fields: [
      { k: 'product', l: '軟體名稱' }, { k: 'version', l: '版本' }, { k: 'serial', l: '序號／金鑰', secret: 1, mono: 1, full: 1 },
      { k: 'email', l: '註冊信箱' }, { k: 'bought', l: '購買日期' }] },
    note: { name: '安全筆記', icon: 'note', fields: [] }
  };
  function subtitle(e) {
    const d = e.data || {};
    switch (e.type) {
      case 'card': return (d.bank ? d.bank + ' ' : '') + (d.number ? '•••• ' + String(d.number).replace(/\s/g, '').slice(-4) : '信用卡');
      case 'identity': return d.doctype || d.fullname || '身分證件';
      case 'wifi': return d.ssid || 'Wi-Fi';
      case 'license': return d.product || '軟體授權';
      case 'note': return '安全筆記';
      default: return e.username || PV.hostOf(e.url) || e.category || '';
    }
  }
  // 主要機密：調色盤 Enter 會複製這個
  function mainSecret(e) {
    const d = e.data || {};
    return { login: [e.password, '密碼'], card: [d.number, '卡號'], identity: [d.docno, '證件號碼'], wifi: [d.wpass, 'Wi-Fi 密碼'], license: [d.serial, '序號'], note: [e.notes, '內容'] }[e.type] || [e.password, '密碼'];
  }

  /* ================= 裝置、稽核、使用統計 ================= */
  async function loadDevice() {
    let d = await Local.get('device');
    if (!d || !d.id) {
      const ua = navigator.userAgent;
      d = { id: PV.uid(), name: DESKTOP ? 'Windows 電腦' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android 手機' : '瀏覽器' };
      await Local.set('device', d);
    }
    S.dev = d;
  }
  const ACT = {
    unlock: '解鎖', unlock_fail: '解鎖失敗', bio_unlock: '生物辨識解鎖', view: '顯示機密', copy: '複製', create: '新增', edit: '修改',
    trash: '移到回收桶', restore: '還原', purge: '永久刪除', import: '匯入', export: '匯出加密備份', export_csv: '匯出 CSV',
    master: '變更主密碼', cloud: '連線雲端', autotype: '自動輸入', att_add: '新增附件', att_open: '開啟附件', att_del: '刪除附件',
    share: '產生邀請碼', report: '安全報告', kit: '緊急存取包', breach: '外洩檢查', batch: '批次操作', bio_on: '啟用生物辨識', bio_off: '停用生物辨識'
  };
  function log(a, e, extra, t) {
    if (!S.data) return;
    S.data.audit.push(Object.assign({ i: PV.uid(), t: t || Date.now(), d: S.dev ? S.dev.name : '', a }, e ? { e: e.id, n: e.title } : {}, extra ? { x: extra } : {}));
    if (S.data.audit.length > 3000) S.data.audit.splice(0, S.data.audit.length - 3000);
    persistSoon();
  }
  function useEntry(e) {
    const u = (S.data.usage[e.id] = S.data.usage[e.id] || {});
    const o = u[S.dev.id] || [0, 0];
    u[S.dev.id] = [o[0] + 1, Date.now()];
    persistSoon();
  }
  function usageOf(id) {
    const u = S.data.usage[id] || {}; let n = 0, last = 0;
    for (const k in u) { n += u[k][0]; last = Math.max(last, u[k][1]); }
    return { n, last };
  }

  /* ================= 剪貼簿 / 網址 ================= */
  let clipToken = 0;
  async function copy(text, label, e) {
    const sec = S.data ? S.data.settings.clipSec : 20;
    try {
      if (DESKTOP) await S.api.copy(text, sec);
      else {
        try { await navigator.clipboard.writeText(text); }
        catch (err) {
          const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        }
        const my = ++clipToken;
        if (sec > 0) setTimeout(() => { if (my === clipToken) navigator.clipboard.writeText('').catch(() => {}); }, sec * 1000);
      }
      if (e) { log('copy', e, label); useEntry(e); }
      toast(`已複製${label || ''}` + (sec > 0 ? `，${sec} 秒後自動清除剪貼簿` : ''));
    } catch (err) { toast('複製失敗：' + err.message); }
  }
  function openUrl(u, e) {
    u = normUrl(u);
    if (!/^https?:\/\//i.test(u)) return toast('只能開啟 http / https 網址');
    if (e) useEntry(e);
    if (DESKTOP) S.api.open_url(u); else window.open(u, '_blank', 'noopener,noreferrer');
  }

  /* ================= 對話框 ================= */
  function closeModal() { modal.classList.add('hidden'); modal.innerHTML = ''; modal.onclick = null; }
  function openModal(html, wire, cls) {
    modal.innerHTML = `<div class="dialog ${cls || ''}" role="dialog">${html}</div>`;
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
  function promptBox(title, msg, opt) {
    opt = opt || {};
    return new Promise(res => {
      openModal(`${dh(opt.icon || 'key', title)}<div class="muted">${msg || ''}</div>
        <${opt.area ? 'textarea' : 'input'} ${opt.area ? '' : `type="${opt.password ? 'password' : 'text'}"`} id="pp" autocomplete="off" autofocus style="margin-top:10px" placeholder="${esc(opt.ph || '')}">${opt.area ? '</textarea>' : ''}
        <div class="btns"><button data-r="0">取消</button><button data-r="1" class="primary">${esc(opt.ok || '確定')}</button></div>`, d => {
        if (opt.value != null) $('#pp', d).value = opt.value;
        const done = ok => { const v = $('#pp', d).value; closeModal(); res(ok ? v : null); };
        d.querySelectorAll('[data-r]').forEach(b => b.onclick = () => done(b.dataset.r === '1'));
        $('#pp', d).onkeydown = e => { if (e.key === 'Enter' && !e.isComposing && !opt.area) done(true); };
      });
    });
  }
  const promptPw = (title, msg) => promptBox(title, msg, { password: true });

  /* ================= 保管庫清單 ================= */
  const VCOLORS = ['#5b82ff', '#22b07d', '#f4b740', '#e2557a', '#9b6bff', '#18a6c9'];
  async function loadVaults() {
    let list = await Local.get('vaults');
    if (!Array.isArray(list) || !list.length) list = [{ id: 'default', name: '個人保管庫', color: VCOLORS[0] }];
    S.vaults = list;
    const cur = await Local.get('current');
    S.vid = list.some(v => v.id === cur) ? cur : list[0].id;
  }
  async function saveVaults() { await Local.set('vaults', S.vaults); await Local.set('current', S.vid); }
  function curVault() { return S.vaults.find(v => v.id === S.vid) || S.vaults[0]; }
  async function switchVault(vid) {
    if (S.session) lock();
    S.vid = vid; await saveVaults();
    await Cloud.load(); setSync(Cloud.cfg ? 'ok' : 'off');
    (await Store.load()) ? renderUnlock() : renderSetup();
  }
  function newVaultId() { return (Date.now().toString(36) + PV.b64(PV.rand(6)).replace(/[^a-z0-9]/gi, '').toLowerCase()).slice(0, 14); }
  async function addVault(name, shared) {
    const v = { id: newVaultId(), name: name || '新保管庫', shared: !!shared, color: VCOLORS[S.vaults.length % VCOLORS.length] };
    S.vaults.push(v);
    await switchVault(v.id);
    return v;
  }
  // 邀請碼：雲端網址 + 保管庫代碼 + 同步密碼（主密碼請另外當面告知）
  function inviteCode() {
    const c = Cloud.cfg, v = curVault();
    return 'PWV1.' + btoa(unescape(encodeURIComponent(JSON.stringify({ u: c.url, ns: c.ns || '', k: c.key, n: v.name })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function parseInvite(code) {
    const m = /^PWV1\.([\w-]+)$/.exec((code || '').trim());
    if (!m) throw new Error('邀請碼格式不對');
    const j = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')))));
    if (!okCloudUrl(j.u) || !j.k) throw new Error('邀請碼內容不完整');
    return j;
  }
  async function joinShared(code) {
    const j = parseInvite(code);
    const id = j.ns || 'default';
    if (S.vaults.some(v => v.id === id)) throw new Error('這台裝置已經有這個保管庫了');
    const cfg = { url: j.u, key: j.k, rev: 0, dirty: false };
    if (j.ns) cfg.ns = j.ns;
    const l = await cloudCall({ a: 'load' }, cfg);
    if (!l.vault) throw new Error('這個共用保管庫在雲端還沒有資料');
    if (S.session) lock();
    S.vaults.push({ id, name: j.n || '共用保管庫', shared: true, color: VCOLORS[S.vaults.length % VCOLORS.length] });
    S.vid = id; await saveVaults();
    await Store.save(l.vault, id);
    cfg.rev = l.rev; cfg.at = Date.now(); Cloud.cfg = cfg; await Cloud.save(id);
    renderUnlock();
    return id;
  }

  /* ================= 建立 / 解鎖 ================= */
  function authShell(inner) {
    return `<div class="auth">
      <aside class="auth-brand">
        <div class="logo"><img src="icons/icon-192.png" alt="">帳號密碼紀錄 <span class="pro">PRO</span></div>
        <h1>你的所有帳號密碼，<br><span>只有你打得開。</span></h1>
        <p class="lead">企業等級加密的密碼保管箱，電腦與手機即時同步。</p>
        <div class="feats">
          <div class="feat"><div class="fi">${I('shield')}</div><div><b>AES-256-GCM 端對端加密</b><small>主密碼經 60 萬次 PBKDF2 衍生金鑰，只在本機解密</small></div></div>
          <div class="feat"><div class="fi">${I('users')}</div><div><b>多保管庫・團隊共用</b><small>工作與個人分開，共用保管庫一鍵邀請</small></div></div>
          <div class="feat"><div class="fi">${I('cloud')}</div><div><b>Google 雲端同步</b><small>雲端只存密文，多台裝置自動合併</small></div></div>
          <div class="feat"><div class="fi">${I('activity')}</div><div><b>稽核紀錄・外洩偵測</b><small>每次檢視與複製都有紀錄，自動比對外洩資料庫</small></div></div>
        </div>
        <div class="auth-foot">v${VERSION}${DESKTOP ? ' · Windows' : ' · Web'} · 零知識架構，沒有後門</div>
      </aside>
      <main class="auth-main"><div class="auth-card">${vaultPicker()}${inner}</div></main>
    </div>`;
  }
  function vaultPicker() {
    if (S.vaults.length < 2) return '';
    return `<div class="vpick"><label class="f" style="margin-top:0">保管庫</label>
      <select id="vpick">${S.vaults.map(v => `<option value="${v.id}" ${v.id === S.vid ? 'selected' : ''}>${esc(v.name)}${v.shared ? '（共用）' : ''}</option>`).join('')}</select></div>`;
  }
  function wireVaultPicker() { const p = $('#vpick'); if (p) p.onchange = () => switchVault(p.value); }
  function renderSetup() {
    const v = curVault(), first = S.vaults.length < 2 && v.id === 'default';
    app.innerHTML = authShell(`
      <h2>${first ? '建立密碼庫' : '建立「' + esc(v.name) + '」'}</h2>
      <div class="sub">${v.shared ? '這是共用保管庫：主密碼要告訴每位成員。' : '設定一組主密碼，用來加密你所有的資料。'}</div>
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
        <button id="join" class="ghost">${I('users')}用邀請碼加入共用保管庫</button>
        <button id="restore" class="ghost">${I('upload')}從備份檔（.pwvault）還原</button>
        ${first ? '' : `<button id="cancelv" class="ghost danger">${I('x')}取消建立這個保管庫</button>`}
      </div>`);
    wireVaultPicker();
    $('#fromcloud').onclick = () => cloudDialog(true);
    $('#join').onclick = () => joinDialog();
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
    $('#restore').onclick = () => pickFile(restoreFromFile);
    const cv = $('#cancelv'); if (cv) cv.onclick = async () => {
      S.vaults = S.vaults.filter(x => x.id !== S.vid);
      await Store.remove(v.id);
      await switchVault(S.vaults[0].id);
    };
  }
  async function createVault(pw) {
    S.session = await PV.newSession(pw);
    S.data = defaults({ createdAt: Date.now() });
    await saveVaults();
    log('unlock');
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
    await saveVaults();
    toast('已還原，請用該備份的主密碼解鎖');
    renderUnlock();
  }

  function renderUnlock() {
    const v = curVault();
    app.innerHTML = authShell(`
      <h2>歡迎回來</h2>
      <div class="sub">「${esc(v.name)}」已上鎖，請輸入主密碼解鎖。${v.shared ? ' <span class="badge warn">共用</span>' : ''}</div>
      <label class="f">主密碼</label>
      <div class="row"><div class="input-icon">${I('key', 'sm')}<input type="password" id="pw" autocomplete="current-password" autofocus></div>
        <button class="icon" id="eye" title="顯示/隱藏">${I('eye')}</button></div>
      <div class="err" id="err"></div>
      <button class="primary block" id="go">${I('lock')}解鎖</button>
      <button class="block bio-btn hidden" id="bio">${I('finger')}${DESKTOP ? '使用 Windows Hello 解鎖' : '使用 Face ID／指紋解鎖'}</button>
      <div class="auth-alt">
        <button id="restore" class="ghost">${I('upload')}從備份檔還原</button>
      </div>`);
    wireVaultPicker();
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
    $('#restore').onclick = () => pickFile(restoreFromFile);
    const bb = $('#bio');
    Bio.enrolled().then(on => { if (on && bb.isConnected) bb.classList.remove('hidden'); });
    bb.onclick = async () => {
      $('#err').textContent = '等待驗證…';
      try {
        const p = await Bio.unlock();
        const r = await unlock(p, true);
        if (r !== true) { $('#err').textContent = '生物辨識存的主密碼已失效，請用主密碼解鎖後重新啟用'; await Bio.remove(); }
      } catch (e) { $('#err').textContent = e.message; }
    };
    setTimeout(() => pw.focus(), 50);
  }
  async function unlock(pw, viaBio) {
    const text = await Store.load();
    if (!text) { renderSetup(); return true; }
    try {
      const r = await PV.open(text, pw);
      S.session = r.session; S.data = defaults(r.data); S.fails = 0; S.lastAct = Date.now();
      S.v = Object.assign(S.v, { edit: null, sel: null, showPw: false, multi: null, filter: 'all', q: '' });
      const fails = (await Local.get('fails.' + S.vid)) || [];
      for (const t of fails) log('unlock_fail', null, null, t);
      if (fails.length) await Local.set('fails.' + S.vid, null);
      log(viaBio ? 'bio_unlock' : 'unlock');
      purgeTrash();
      renderMain();
      if (Cloud.cfg) syncNow();
      if (S.pendingPalette) { S.pendingPalette = false; openPalette(true); }
      return true;
    } catch (e) {
      if (e.message !== 'BAD_PASSWORD') return '密碼庫檔案損壞：' + e.message;
      S.fails++;
      const fails = (await Local.get('fails.' + S.vid)) || [];
      fails.push(Date.now()); await Local.set('fails.' + S.vid, fails.slice(-50));
      return `主密碼錯誤（第 ${S.fails} 次）`;
    }
  }
  function lock(reason) {
    if (!S.session) return;
    // 切換保管庫時 S.vid 會馬上變，所以這裡先記住是哪個保管庫
    const vid = S.vid, c = Cloud.cfg;
    if (soonT) {
      clearTimeout(soonT); soonT = 0;
      PV.seal(S.session, S.data).then(async t => {
        await Store.save(t, vid);
        if (c) { c.dirty = true; await Cloud.save(vid, c); flushOnLock(c, t, vid); }
      }).catch(() => {});
    } else flushOnLock(c, S.lastSealed, vid);
    S.session = null; S.data = null; S.lastSealed = null;
    S.v = Object.assign(S.v, { edit: null, sel: null, q: '', multi: null });
    closeModal(); closePalette();
    renderUnlock();
    if (reason) toast(reason);
  }

  /* ================= 統計與篩選 ================= */
  function live() { return S.data.entries.filter(e => !e.trashedAt); }
  function breached(e) { const b = S.data.breach[e.id]; return !!(b && b.n > 0 && b.at >= (e.pwAt || e.createdAt || 0) && e.password); }
  function stats() {
    const es = live(), cats = {}, tags = {}, pwCount = {}, types = {};
    let weak = 0, reused = 0, fav = 0, leak = 0;
    for (const e of es) {
      if (e.category) cats[e.category] = (cats[e.category] || 0) + 1;
      for (const t of e.tags || []) tags[t] = (tags[t] || 0) + 1;
      types[e.type] = (types[e.type] || 0) + 1;
      if (e.type === 'login' && e.password) pwCount[e.password] = (pwCount[e.password] || 0) + 1;
      if (e.fav) fav++;
    }
    for (const e of es) {
      if (e.type !== 'login' || !e.password) continue;
      if (PV.strength(e.password).score <= 1) weak++;
      if (pwCount[e.password] > 1) reused++;
      if (breached(e)) leak++;
    }
    return { cats, tags, pwCount, types, weak, reused, fav, leak, nocat: es.filter(e => !e.category).length,
      trash: S.data.entries.length - es.length, n: es.length };
  }
  function haystack(e) {
    const t = TYPES[e.type] || TYPES.login, d = e.data || {};
    return [e.title, e.url, e.username, e.notes, e.category, (e.tags || []).join(' '), TYPES[e.type] ? TYPES[e.type].name : '',
      ...t.fields.filter(f => !f.secret).map(f => d[f.k]), ...(e.fields || []).map(f => f.n + ' ' + (f.s ? '' : f.v)),
      ...(e.att || []).map(a => a.name)].join('\n').toLowerCase();
  }
  function filtered(st) {
    const f = S.v.filter, q = S.v.q.trim().toLowerCase();
    let es = (f === 'trash' ? S.data.entries.filter(e => e.trashedAt) : live()).filter(e => {
      if (f === 'fav') return e.fav;
      if (f === 'nocat') return !e.category;
      if (f === 'weak') return e.type === 'login' && e.password && PV.strength(e.password).score <= 1;
      if (f === 'reused') return e.type === 'login' && e.password && st.pwCount[e.password] > 1;
      if (f === 'leak') return e.type === 'login' && breached(e);
      if (f === 'stale') { const u = usageOf(e.id); return Date.now() - Math.max(u.last, e.createdAt || 0) > 180 * 864e5; }
      if (f.startsWith('cat:')) return e.category === f.slice(4);
      if (f.startsWith('tag:')) return (e.tags || []).includes(f.slice(4));
      if (f.startsWith('type:')) return e.type === f.slice(5);
      return true;
    });
    if (q) { const words = q.split(/\s+/); es = es.filter(e => { const h = haystack(e); return words.every(w => h.includes(w)); }); }
    const by = {
      recent: (a, b) => b.updatedAt - a.updatedAt,
      used: (a, b) => usageOf(b.id).n - usageOf(a.id).n || a.title.localeCompare(b.title, 'zh-Hant'),
      lastused: (a, b) => usageOf(b.id).last - usageOf(a.id).last,
      name: (a, b) => (b.fav - a.fav) || a.title.localeCompare(b.title, 'zh-Hant')
    };
    const cmp = f === 'trash' ? (a, b) => b.trashedAt - a.trashedAt : by[S.v.sort] || by.name;
    if (f === 'reused') return es.sort((a, b) => a.password.localeCompare(b.password) || cmp(a, b));
    return es.sort(cmp);
  }
  function purgeTrash() {
    const cut = Date.now() - TRASH_DAYS * 864e5;
    const old = S.data.entries.filter(e => e.trashedAt && e.trashedAt < cut);
    if (old.length) { for (const e of old) hardDelete(e); persist().catch(() => {}); }
  }
  function hardDelete(e) {
    S.data.entries = S.data.entries.filter(x => x.id !== e.id);
    S.data.deleted[e.id] = Date.now();
    delete S.data.usage[e.id]; delete S.data.breach[e.id];
    for (const a of e.att || []) dropAtt(a.id);
  }

  /* ================= 主畫面 ================= */
  function renderMain() {
    app.innerHTML = `<div class="shell" id="shell">
      <nav class="side" id="side"></nav>
      <section class="list">
        <div class="top">
          <button class="icon ghost menu-btn" data-act="menu" title="選單">${I('menu')}</button>
          <div class="input-icon">${I('search', 'sm')}<input type="search" id="q" placeholder="搜尋名稱、帳號、網址…" value="${esc(S.v.q)}" autocomplete="off"></div>
          <button class="primary" data-act="new" title="新增（Ctrl+N）">${I('plus')}<span>新增</span></button>
        </div>
        <div class="bar" id="lbar"></div>
        <div class="items" id="items"></div>
      </section>
      <section class="detail" id="detail"></section>
    </div>`;
    $('#q').oninput = e => { S.v.q = e.target.value; renderList(); };
    renderAll();
  }
  function renderAll() { const st = stats(); renderSide(st); renderList(st); renderDetail(st); layoutClass(); }
  function layoutClass() {
    const sh = $('#shell'); if (!sh) return;
    sh.classList.toggle('show-detail', !!(S.v.sel || S.v.edit));
    sh.classList.toggle('side-open', S.v.sideOpen);
  }
  function renderSide(st) {
    const f = S.v.filter, v = curVault();
    const a = (key, icon, label, cnt, cls) => `<a data-f="${esc(key)}" class="${f === key ? 'on' : ''} ${cls || ''}">${I(icon)}<span class="lbl">${label}</span><span class="n">${cnt}</span></a>`;
    const cats = Object.keys(st.cats).sort((x, y) => x.localeCompare(y, 'zh-Hant'));
    const tags = Object.keys(st.tags).sort((x, y) => x.localeCompare(y, 'zh-Hant'));
    const types = Object.keys(TYPES).filter(t => st.types[t]);
    $('#side').innerHTML = `<div class="logo"><img src="icons/icon-192.png" alt=""><span>帳號密碼紀錄</span><span class="pro">PRO</span></div>
      <button class="vswitch" data-act="vaults"><span class="vdot" style="background:${v.color}"></span><span class="lbl">${esc(v.name)}</span>${v.shared ? '<span class="vtag">共用</span>' : ''}${I('down', 'sm')}</button>
      <div class="nav">${a('all', 'all', '所有項目', st.n)}${a('fav', 'star', '我的最愛', st.fav)}
      ${types.length > 1 || (types[0] && types[0] !== 'login') ? '<h4>類型</h4>' + types.map(t => a('type:' + t, TYPES[t].icon, TYPES[t].name, st.types[t])).join('') : ''}
      <h4>分類</h4>${cats.map(c => a('cat:' + c, 'folder', esc(c), st.cats[c])).join('')}${a('nocat', 'inbox', '未分類', st.nocat)}
      ${tags.length ? '<h4>標籤</h4>' + tags.map(t => a('tag:' + t, 'hash', esc(t), st.tags[t])).join('') : ''}
      <h4>安全中心</h4>${a('leak', 'globe', '已外洩', st.leak, st.leak ? 'bad' : '')}${a('weak', 'alert', '弱密碼', st.weak, st.weak ? 'bad' : '')}${a('reused', 'repeat', '重複使用', st.reused, st.reused ? 'bad' : '')}
      ${a('trash', 'trash', '回收桶', st.trash)}</div>
      ${syncHtml()}
      <div class="tools">
        <a data-act="palette">${I('bolt')}<span class="lbl">快速搜尋</span><kbd>${DESKTOP ? 'Ctrl Alt P' : 'Ctrl K'}</kbd></a>
        <a data-act="gen">${I('dice')}<span class="lbl">密碼產生器</span></a>
        <a data-act="settings">${I('sliders')}<span class="lbl">設定與管理</span></a>
        <a data-act="lock">${I('lock')}<span class="lbl">立即上鎖</span><kbd>Ctrl L</kbd></a>
      </div>`;
  }
  function renderBar(count) {
    const b = $('#lbar'); if (!b) return;
    const m = S.v.multi, trash = S.v.filter === 'trash';
    if (m) {
      b.className = 'bar multi';
      b.innerHTML = `<span><b>已選 ${m.size}</b> 項</span><span class="mbtns">
        <button class="ghost" data-act="m_all">全選</button>
        ${trash ? `<button data-act="m_restore">${I('restore', 'sm')}還原</button><button class="danger" data-act="m_purge">${I('trash', 'sm')}永久刪除</button>`
        : `<button data-act="m_move">${I('folder', 'sm')}分類</button><button data-act="m_tag">${I('hash', 'sm')}標籤</button><button data-act="m_fav">${I('star', 'sm')}最愛</button><button class="danger" data-act="m_trash">${I('trash', 'sm')}刪除</button>`}
        <button class="ghost icon" data-act="m_off" title="結束選取">${I('x')}</button></span>`;
      return;
    }
    b.className = 'bar';
    b.innerHTML = `<span><b>${count}</b> 個項目</span><span class="mbtns">
      ${trash && count ? `<button class="ghost danger" data-act="emptytrash">${I('trash', 'sm')}清空</button>` : ''}
      <button class="ghost" data-act="m_on" title="多選批次操作">${I('boxck', 'sm')}選取</button>
      ${trash ? '' : `<select id="sort" title="排序"><option value="name">依名稱</option><option value="recent">最近修改</option><option value="used">最常使用</option><option value="lastused">最近使用</option></select>`}</span>`;
    const so = $('#sort'); if (so) { so.value = S.v.sort; so.onchange = e => { S.v.sort = e.target.value; renderList(); }; }
  }
  function renderList(st) {
    st = st || stats();
    const es = filtered(st), box = $('#items');
    if (!box) return;
    renderBar(es.length);
    if (!es.length) {
      const trash = S.v.filter === 'trash';
      box.innerHTML = `<div class="empty"><div class="ei">${I(trash ? 'trash' : st.n ? 'search' : 'key', 'lg')}</div>${trash ? `回收桶是空的<br><span style="font-size:12.5px">刪除的項目會保留 ${TRASH_DAYS} 天</span>` : st.n ? '沒有符合的項目' : `<b style="color:var(--text)">還沒有任何資料</b><br>
        <button class="primary" data-act="new" style="margin:14px 0">${I('plus')}新增第一筆</button><br>
        <span style="font-size:12.5px">或到「設定與管理」匯入瀏覽器匯出的 CSV</span>`}</div>`;
      return;
    }
    const m = S.v.multi;
    box.innerHTML = es.map(e => {
      const weak = e.type === 'login' && e.password && (PV.strength(e.password).score <= 1 || breached(e));
      return `<div class="item ${S.v.sel === e.id && !m ? 'on' : ''} ${m && m.has(e.id) ? 'picked' : ''}" data-id="${e.id}">
      ${m ? `<span class="ck">${I(m.has(e.id) ? 'boxck' : 'box')}</span>` : ''}${avatar(e)}<div class="meta"><div class="t">${esc(e.title)}</div>
      <div class="s">${S.v.filter === 'trash' ? '刪除於 ' + ago(e.trashedAt) : esc(subtitle(e))}</div></div>
      ${(e.att || []).length ? `<span class="clipc" title="${e.att.length} 個附件">${I('clip', 'sm')}</span>` : ''}
      ${weak ? '<span class="flag" title="弱密碼或已外洩"></span>' : ''}${e.fav ? `<span class="star">${I('star', 'sm')}</span>` : ''}</div>`;
    }).join('');
  }
  function cur() { return S.data.entries.find(e => e.id === S.v.sel); }

  /* ---------- 詳細內容 ---------- */
  function renderDetail(st) {
    const d = $('#detail'); if (!d) return;
    if (S.v.edit) return renderEdit(d);
    const e = cur();
    if (!e) return renderOverview(d, st || stats());
    const show = S.v.showPw, s = PV.strength(e.password);
    const reused = e.type === 'login' && e.password && live().filter(x => x.password === e.password).length;
    const op = (act, icon, title, extra) => `<button class="icon ghost" data-act="${act}" ${extra || ''} title="${title}">${I(icon)}</button>`;
    const fr = (icon, k, val, ops, cls) => `<div class="fr"><div class="k">${I(icon, 'sm')}${k}</div><div class="val ${cls || ''}">${val}</div><div class="ops">${ops || ''}</div></div>`;
    const mask = '••••••••••••';
    const host = PV.hostOf(e.url), T = TYPES[e.type] || TYPES.login, dd = e.data || {};
    let main = '';
    if (e.type === 'login') {
      main = [
        e.username && fr('user', '帳號', esc(e.username), op('cp', 'copy', '複製帳號', 'data-f2="username"')),
        e.password && fr('key', '密碼', show ? esc(e.password) : mask, op('eye', 'eye', '顯示/隱藏') + op('cp', 'copy', '複製密碼', 'data-f2="password"'), 'mono'),
        e.url && fr('link', '網址', `<a href="#" data-act="open">${esc(e.url)}</a>`, op('open', 'ext', '開啟網站') + op('cp', 'copy', '複製網址', 'data-f2="url"'))
      ].filter(Boolean).join('');
    } else if (e.type === 'note') {
      main = e.notes ? `<div class="notebody">${show || !e.notes ? esc(e.notes) : '<span class="muted">內容已隱藏，按右邊眼睛顯示</span>'}</div>
        <div class="fr" style="border-top:1px solid var(--line-2)"><div class="k"></div><div class="val"></div><div class="ops">${op('eye', 'eye', '顯示/隱藏')}${op('cp', 'copy', '複製內容', 'data-f2="notes"')}</div></div>` : '';
    } else {
      main = T.fields.filter(f => dd[f.k]).map(f => fr(f.secret ? 'key' : 'info', f.l, f.secret && !show ? mask : esc(dd[f.k]),
        (f.secret ? op('eye', 'eye', '顯示/隱藏') : '') + op('cp', 'copy', '複製' + f.l, `data-d="${f.k}"`), f.mono ? 'mono' : '')).join('');
    }
    const custom = (e.fields || []).filter(f => f.n || f.v).map((f, i) => fr(f.s ? 'key' : 'type', esc(f.n || '欄位'), f.s && !show ? mask : esc(f.v),
      (f.s ? op('eye', 'eye', '顯示/隱藏') : '') + op('cp', 'copy', '複製', `data-cf="${i}"`), f.s ? 'mono' : '')).join('');
    const more = [
      e.category && fr('folder', '分類', `<span class="chip" data-f="cat:${esc(e.category)}">${I('folder', 'sm')}${esc(e.category)}</span>`),
      e.tags.length && fr('hash', '標籤', `<div class="chips">${e.tags.map(t => `<span class="chip" data-f="tag:${esc(t)}">#${esc(t)}</span>`).join('')}</div>`),
      e.notes && e.type !== 'note' && fr('note', '備註', esc(e.notes), op('cp', 'copy', '複製備註', 'data-f2="notes"'))
    ].filter(Boolean).join('');
    const u = usageOf(e.id), b = S.data.breach[e.id], trash = !!e.trashedAt;
    d.innerHTML = `<div class="dwrap">
      ${trash ? `<div class="notice" style="margin-bottom:12px">${I('trash', 'sm')}<span>這個項目在回收桶裡，${TRASH_DAYS} 天後（${fmtTime(e.trashedAt + TRASH_DAYS * 864e5).slice(0, 10)}）會永久刪除。</span></div>` : ''}
      <div class="hero">
        <button class="icon ghost back" data-act="back" title="返回">${I('back')}</button>
        ${avatar(e)}
        <div class="ht"><h2>${esc(e.title)}</h2>
          <div class="hs"><span class="badge plain">${I(T.icon, 'sm')}${T.name}</span>${host ? `<span>${esc(host)}</span>` : ''}${e.category ? `<span>· ${esc(e.category)}</span>` : ''}
          ${e.type === 'login' && e.password ? strengthBadge(s) : ''}${breached(e) ? `<span class="badge bad">${I('globe', 'sm')}已外洩 ${b.n.toLocaleString()} 次</span>` : ''}</div></div>
        <div class="acts">
          ${trash ? `<button data-act="restore">${I('restore')}<span>還原</span></button><button class="danger-solid" data-act="purge">${I('trash')}<span>永久刪除</span></button>` : `
          <button class="icon ${e.fav ? 'fav-on' : ''}" data-act="fav" title="${e.fav ? '取消最愛' : '加入最愛'}">${I('star')}</button>
          ${DESKTOP && e.type === 'login' && e.password ? `<button data-act="autotype" title="縮小視窗，3 秒後在目前游標位置輸入帳號、Tab、密碼、Enter">${I('kbd')}<span>自動輸入</span></button>` : ''}
          <button data-act="dup" title="複製成新項目">${I('dup')}<span>複製</span></button>
          <button class="primary" data-act="edit">${I('edit')}<span>編輯</span></button>`}
        </div>
      </div>
      ${main ? `<div class="card"><h3>${I(T.icon, 'sm')}${e.type === 'login' ? '登入資訊' : T.name}</h3>${main}
        ${e.type === 'login' && e.password ? `<div class="cb">${meter(e.password)}${reused > 1 ? `<div class="sl s0">${I('repeat', 'sm')} 有 ${reused} 個項目使用相同密碼，建議更換</div>` : ''}
          ${breached(e) ? `<div class="sl s0">${I('globe', 'sm')} 這組密碼出現在已知外洩資料中 ${b.n.toLocaleString()} 次，請立即更換</div>` : ''}</div>` : ''}</div>` : ''}
      ${custom ? `<div class="card"><h3>${I('type', 'sm')}自訂欄位</h3>${custom}</div>` : ''}
      ${more ? `<div class="card"><h3>${I('info', 'sm')}詳細資料</h3>${more}</div>` : ''}
      <div class="card"><h3>${I('clip', 'sm')}附件（${e.att.length}）${trash ? '' : `<button class="ghost h3btn" data-act="att_add">${I('plus', 'sm')}新增附件</button>`}</h3>
        ${e.att.length ? e.att.map(a => `<div class="fr att"><div class="k">${I(/^image\//.test(a.type) ? 'image' : 'file', 'sm')}${fmtSize(a.size)}</div>
          <div class="val"><a href="#" data-act="att_open" data-a="${a.id}">${esc(a.name)}</a></div>
          <div class="ops">${op('att_open', /^image\//.test(a.type) ? 'eye' : 'download', /^image\//.test(a.type) ? '預覽' : '儲存', `data-a="${a.id}"`)}${trash ? '' : op('att_del', 'trash', '刪除附件', `data-a="${a.id}"`)}</div></div>`).join('')
        : '<div class="cb muted" style="padding-top:12px;font-size:13px">可以附加證件照、合約、備用碼等檔案（單檔 10 MB 以內），一樣加密保存並同步。</div>'}</div>
      ${(e.history || []).length ? `<details class="card"><summary>${I('clock', 'sm')}舊密碼紀錄（${e.history.length}）</summary>
        ${e.history.map((h, i) => `<div class="hist-row"><span class="when">${fmtTime(h.at)} 停用</span><span class="val mono">${show ? esc(h.pw) : '••••••••••'}</span>
        <button class="icon ghost" data-act="cph" data-i="${i}" title="複製">${I('copy')}</button></div>`).join('')}</details>` : ''}
      <div class="metaline"><span>${I('plus', 'sm')}建立 ${fmtTime(e.createdAt)}</span><span>${I('edit', 'sm')}修改 ${fmtTime(e.updatedAt)}</span>
        <span>${I('chart', 'sm')}使用 ${u.n} 次・上次 ${ago(u.last)}</span><a href="#" data-act="audit_item">${I('activity', 'sm')}這筆的稽核紀錄</a></div>
      ${trash ? '' : `<div class="dangerzone"><button class="danger" data-act="del">${I('trash')}移到回收桶</button></div>`}
    </div>`;
  }
  function renderOverview(d, st) {
    const es = live(), n = es.length, risky = new Set();
    for (const e of es) if (e.type === 'login' && e.password && (PV.strength(e.password).score <= 1 || st.pwCount[e.password] > 1 || breached(e))) risky.add(e.id);
    const logins = es.filter(e => e.type === 'login' && e.password).length;
    const score = logins ? Math.round(100 * (logins - risky.size) / logins) : 100;
    const rc = score >= 80 ? 'var(--ok)' : score >= 50 ? 'var(--warn)' : 'var(--danger)';
    const kpi = (f, icon, label, v, cls) => `<div class="kpi ${cls || ''}" data-f="${f}"><div class="kh">${label}<span class="ic">${I(icon, 'sm')}</span></div><div class="kv">${v}</div></div>`;
    const c = Cloud.cfg, v = curVault();
    const top = es.map(e => [e, usageOf(e.id)]).filter(x => x[1].n).sort((a, b) => b[1].n - a[1].n).slice(0, 5);
    const stale = es.filter(e => Date.now() - Math.max(usageOf(e.id).last, e.createdAt || 0) > 180 * 864e5).length;
    const lastCheck = Math.max(0, ...Object.values(S.data.breach).map(b => b.at));
    d.innerHTML = `<div class="dwrap overview">
      <h1>${esc(v.name)} ${v.shared ? '<span class="badge warn" style="vertical-align:4px">共用</span>' : ''}</h1>
      <div class="sub">密碼庫狀態一覽　·　這台裝置：${esc(S.dev.name)}　·　閒置 ${S.data.settings.lockMin || '∞'} 分鐘自動上鎖</div>
      <div class="kpis">
        ${kpi('all', 'all', '項目總數', n)}${kpi('leak', 'globe', '已外洩', st.leak, st.leak ? 'bad' : '')}
        ${kpi('weak', 'alert', '弱密碼', st.weak, st.weak ? 'bad' : '')}${kpi('reused', 'repeat', '重複使用', st.reused, st.reused ? 'bad' : '')}
      </div>
      <div class="card"><div class="health">
        <div class="ring" style="--p:${score};--rc:${rc}"><div>${score}</div></div>
        <div style="flex:1"><h4>密碼健康分數</h4><p>${risky.size ? `有 ${risky.size} 個登入使用弱密碼、重複密碼或已外洩，點上方卡片可直接查看並更換。` : logins ? '所有登入密碼都夠強、沒有重複，也沒有出現在外洩資料中。' : '新增帳號後會在這裡顯示密碼健康狀況。'}</p>
          <p style="margin-top:6px">外洩檢查：${lastCheck ? '上次 ' + ago(lastCheck) : '尚未檢查'}</p></div>
        <div class="hbtns"><button data-act="breach">${I('globe')}外洩檢查</button><button data-act="report">${I('printer')}安全報告</button></div>
      </div></div>
      <div class="grid-2">
        <div class="card"><h3>${I('chart', 'sm')}最常使用</h3>${top.length ? top.map(([e, u]) => `<div class="fr link" data-id="${e.id}"><div class="k">${u.n} 次</div><div class="val">${esc(e.title)}</div><div class="ops muted" style="font-size:12px">${ago(u.last)}</div></div>`).join('')
          : '<div class="cb muted" style="padding-top:12px;font-size:13px">複製帳號密碼或開啟網址時會自動統計。</div>'}</div>
        <div class="card"><h3>${I('clock', 'sm')}使用概況</h3>
          <div class="fr link" data-f="stale"><div class="k">${I('clock', 'sm')}久未使用</div><div class="val">${stale} 個項目超過 180 天沒用</div><div class="ops">${I('back', 'sm flip')}</div></div>
          <div class="fr link" data-f="fav"><div class="k">${I('star', 'sm')}我的最愛</div><div class="val">${st.fav} 個</div><div class="ops">${I('back', 'sm flip')}</div></div>
          <div class="fr link" data-f="trash"><div class="k">${I('trash', 'sm')}回收桶</div><div class="val">${st.trash} 個</div><div class="ops">${I('back', 'sm flip')}</div></div>
          <div class="fr link" data-act="audit"><div class="k">${I('activity', 'sm')}稽核紀錄</div><div class="val">${S.data.audit.length} 筆</div><div class="ops">${I('back', 'sm flip')}</div></div>
        </div>
      </div>
      <div class="card"><h3>${I('cloud', 'sm')}雲端同步</h3><div class="fr"><div class="k">${I('cloud', 'sm')}狀態</div>
        <div class="val">${c ? (S.sync.state === 'err' ? `<span class="badge bad">同步失敗</span> ${esc(S.sync.msg)}` : `<span class="badge ok">已連線</span>　版本 ${c.rev}${c.at ? '　·　' + fmtTime(c.at) : ''}`) : '<span class="badge warn">未連線</span>　資料只存在這台裝置'}</div>
        <div class="ops"><button data-act="${c ? 'syncnow' : 'cloudset'}">${I(c ? 'refresh' : 'cloud')}${c ? '立即同步' : '連線'}</button></div></div></div>
      <div class="card"><h3>${I('info', 'sm')}快速鍵</h3><div class="keys">
        ${DESKTOP ? '<span><kbd>Ctrl Alt P</kbd> 任何程式中叫出快速搜尋</span>' : ''}<span><kbd>Ctrl K</kbd> 快速搜尋</span><span><kbd>Ctrl N</kbd> 新增</span><span><kbd>Ctrl F</kbd> 搜尋</span><span><kbd>Ctrl G</kbd> 產生密碼</span><span><kbd>Ctrl S</kbd> 儲存</span><span><kbd>Ctrl L</kbd> 上鎖</span></div></div>
      <div class="metaline"><span>${I('shield', 'sm')}AES-256-GCM · PBKDF2 600,000</span><span>v${VERSION} PRO${DESKTOP ? ' · Windows' : ' · Web'}</span></div>
    </div>`;
  }

  /* ---------- 新增 / 編輯 ---------- */
  function typePicker() {
    openModal(`${dh('plus', '新增項目')}<div class="tpick">${Object.entries(TYPES).map(([k, t]) =>
      `<button data-t="${k}"><span class="ti">${I(t.icon, 'lg')}</span>${t.name}</button>`).join('')}</div>
      <div class="btns"><button id="tp_no">取消</button></div>`, d => {
      $('#tp_no', d).onclick = closeModal;
      $$('[data-t]', d).forEach(b => b.onclick = () => { closeModal(); startNew(b.dataset.t); });
    });
  }
  function startNew(type) {
    const f = S.v.filter;
    S.v.edit = newEntry(Object.assign({ type }, f.startsWith('cat:') ? { category: f.slice(4) } : {}));
    S.v.showPw = false; S.v.sideOpen = false; S.v.multi = null;
    renderAll();
  }
  function renderEdit(d) {
    const e = S.v.edit, cats = Object.keys(stats().cats).sort(), T = TYPES[e.type] || TYPES.login, dd = e.data || {};
    const isNew = !S.data.entries.some(x => x.id === e.id);
    const inp = (id, val, ph, extra) => `<input id="${id}" value="${esc(val)}" placeholder="${esc(ph || '')}" autocomplete="off" ${extra || ''}>`;
    let main;
    if (e.type === 'login') {
      main = `<div><label class="f">帳號 / Email</label>${inp('e_username', e.username)}</div>
        <div><label class="f">網址</label>${inp('e_url', e.url, 'https://', 'inputmode="url"')}</div>
        <div class="full"><label class="f">密碼</label>
          <div class="row"><input id="e_password" type="${S.v.showPw ? 'text' : 'password'}" class="mono" value="${esc(e.password)}" autocomplete="new-password">
            <button class="icon" data-act="eye2" title="顯示/隱藏">${I('eye')}</button>
            <button class="icon" data-act="quickgen" title="直接產生一組強密碼">${I('dice')}</button>
            <button class="icon" data-act="gen2" title="產生器設定">${I('sliders')}</button></div>
          <div id="e_meter">${meter(e.password)}</div></div>`;
    } else if (e.type === 'note') {
      main = `<div class="full"><label class="f">內容</label><textarea id="e_notes" style="min-height:220px" placeholder="只有你看得到的內容，例如保險箱密碼、備用碼…">${esc(e.notes)}</textarea></div>`;
    } else {
      main = T.fields.map(f => `<div class="${f.full ? 'full' : ''}"><label class="f">${f.l}</label>
        ${f.secret ? `<div class="row"><input id="d_${f.k}" type="${S.v.showPw ? 'text' : 'password'}" class="mono" value="${esc(dd[f.k] || '')}" placeholder="${esc(f.ph || '')}" autocomplete="off">
          <button class="icon" data-act="eye3" title="顯示/隱藏">${I('eye')}</button></div>` : inp('d_' + f.k, dd[f.k] || '', f.ph)}</div>`).join('');
    }
    d.innerHTML = `<div class="dwrap">
      <div class="hero"><button class="icon ghost back" data-act="cancel" title="返回">${I('back')}</button>
        <div class="av" style="background:var(--primary)">${I(T.icon)}</div>
        <div class="ht"><h2>${isNew ? '新增' + T.name : '編輯：' + esc(e.title)}</h2><div class="hs">標示 * 為必填，其餘可留白</div></div></div>
      <div class="card"><h3>${I(T.icon, 'sm')}${T.name}</h3><div class="cb"><div class="form-grid">
        <div class="full"><label class="f">名稱 *</label>${inp('e_title', e.title, { login: '例如：Google、公司 VPN', card: '例如：玉山 Pi 卡', identity: '例如：我的護照', wifi: '例如：家裡 Wi-Fi', license: '例如：Office 2021', note: '例如：保險箱密碼' }[e.type])}</div>
        ${main}
      </div></div></div>
      <div class="card"><h3>${I('type', 'sm')}自訂欄位<button class="ghost h3btn" data-act="cf_add">${I('plus', 'sm')}新增欄位</button></h3><div class="cb" id="cflist">${cfRows(e)}</div></div>
      <div class="card"><h3>${I('info', 'sm')}詳細資料</h3><div class="cb"><div class="form-grid">
        <div><label class="f">分類</label><input id="e_category" value="${esc(e.category)}" list="catlist" placeholder="例如：工作、銀行、購物" autocomplete="off"></div>
        <datalist id="catlist">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <div><label class="f">標籤（逗號分隔）</label><input id="e_tags" value="${esc((e.tags || []).join(', '))}" autocomplete="off"></div>
        ${e.type === 'note' ? '' : `<div class="full"><label class="f">備註</label><textarea id="e_notes" placeholder="安全提問、PIN、備用碼…">${esc(e.notes)}</textarea></div>`}
        <div class="full"><label class="check"><input type="checkbox" id="e_fav" ${e.fav ? 'checked' : ''}> 加入我的最愛</label></div>
      </div></div></div>
      <div class="formbar"><button data-act="cancel">取消</button><button class="primary" data-act="save">${I('check')}儲存<kbd style="background:rgba(255,255,255,.15);border-color:transparent;color:#fff">Ctrl S</kbd></button></div>
    </div>`;
    const pw = $('#e_password'); if (pw) pw.oninput = ev => { $('#e_meter').innerHTML = meter(ev.target.value); };
    setTimeout(() => { const t = $('#e_title'); if (t && !t.value) t.focus(); }, 30);
  }
  function cfRows(e) {
    if (!e.fields.length) return '<div class="muted" style="font-size:13px;padding-top:10px">需要更多欄位（例如：員工編號、安全提問、備用信箱）時，按右上角「新增欄位」。</div>';
    return e.fields.map((f, i) => `<div class="cfrow" data-i="${i}">
      <input class="cf_n" value="${esc(f.n)}" placeholder="欄位名稱" autocomplete="off">
      <input class="cf_v ${f.s ? 'mono' : ''}" type="${f.s && !S.v.showPw ? 'password' : 'text'}" value="${esc(f.v)}" placeholder="內容" autocomplete="off">
      <label class="check" title="機密欄位會遮蔽顯示"><input type="checkbox" class="cf_s" ${f.s ? 'checked' : ''}>機密</label>
      <button class="icon ghost" data-act="cf_del" data-i="${i}" title="移除">${I('x')}</button></div>`).join('');
  }
  function readEdit() {
    const e = S.v.edit; if (!e) return;
    const val = id => { const el = $('#' + id); return el ? el.value : null; };
    for (const k of ['title', 'username', 'url', 'category']) { const v = val('e_' + k); if (v != null) e[k] = v.trim(); }
    for (const k of ['password', 'notes']) { const v = val('e_' + k); if (v != null) e[k] = v; }
    for (const f of (TYPES[e.type] || TYPES.login).fields) { const v = val('d_' + f.k); if (v != null) e.data[f.k] = f.secret ? v : v.trim(); }
    const t = $('#e_tags'); if (t) e.tags = [...new Set(t.value.split(/[,，;；]/).map(s => s.trim()).filter(Boolean))];
    const fv = $('#e_fav'); if (fv) e.fav = fv.checked;
    $$('.cfrow').forEach(r => { const f = e.fields[+r.dataset.i]; if (f) { f.n = $('.cf_n', r).value.trim(); f.v = $('.cf_v', r).value; f.s = $('.cf_s', r).checked; } });
  }
  async function saveEdit() {
    readEdit();
    const e = S.v.edit;
    if (!e.title) e.title = PV.hostOf(e.url) || e.username || (e.data || {}).ssid || (e.data || {}).product || '';
    if (!e.title) { toast('請輸入名稱'); $('#e_title').focus(); return; }
    e.fields = e.fields.filter(f => f.n || f.v);
    const old = S.data.entries.find(x => x.id === e.id);
    e.updatedAt = Date.now();
    if (old) {
      if (old.password && old.password !== e.password) { e.history = [{ pw: old.password, at: Date.now() }].concat(old.history || []).slice(0, 10); e.pwAt = Date.now(); }
      Object.assign(old, e);
      log('edit', old);
    } else { e.pwAt = Date.now(); S.data.entries.push(e); log('create', e); }
    S.v.sel = e.id; S.v.edit = null; S.v.showPw = false;
    await persist();
    renderAll();
    toast('已儲存');
  }

  /* ---------- 回收桶與批次 ---------- */
  async function toTrash(list) {
    const now = Date.now();
    for (const e of list) { e.trashedAt = now; e.updatedAt = now; log('trash', e); }
    S.v.sel = null; await persist(); renderAll();
    toast(`已移到回收桶（${list.length} 項），${TRASH_DAYS} 天內可還原`);
  }
  async function restoreItems(list) {
    const now = Date.now();
    for (const e of list) { delete e.trashedAt; e.updatedAt = now; log('restore', e); }
    await persist(); renderAll(); toast(`已還原 ${list.length} 項`);
  }
  async function purgeItems(list) {
    if (!(await confirmBox('永久刪除', `確定永久刪除 <b>${list.length}</b> 個項目（含附件）？<b>無法復原</b>。`, '永久刪除', true))) return;
    for (const e of list) { log('purge', e); hardDelete(e); }
    S.v.sel = null; S.v.multi = null; await persist(); renderAll(); toast('已永久刪除');
  }
  function picked() { return S.data.entries.filter(e => S.v.multi && S.v.multi.has(e.id)); }
  async function batch(act) {
    const list = picked();
    if (!list.length && !['m_all', 'm_off'].includes(act)) return toast('請先勾選項目');
    switch (act) {
      case 'm_all': { const ids = filtered(stats()).map(e => e.id); S.v.multi = new Set(S.v.multi.size === ids.length ? [] : ids); renderList(); return; }
      case 'm_off': S.v.multi = null; renderList(); return;
      case 'm_move': {
        const c = await promptBox('移動到分類', `把 ${list.length} 個項目移到哪個分類？（留空 = 未分類）`, { icon: 'folder', ph: '例如：工作' });
        if (c == null) return;
        list.forEach(e => { e.category = c.trim(); e.updatedAt = Date.now(); }); break;
      }
      case 'm_tag': {
        const t = await promptBox('加上標籤', `替 ${list.length} 個項目加上標籤（逗號分隔多個）`, { icon: 'hash', ph: '例如：重要, 公司' });
        if (!t) return;
        const tags = t.split(/[,，;；]/).map(s => s.trim()).filter(Boolean);
        list.forEach(e => { e.tags = [...new Set(e.tags.concat(tags))]; e.updatedAt = Date.now(); }); break;
      }
      case 'm_fav': { const on = !list.every(e => e.fav); list.forEach(e => { e.fav = on; e.updatedAt = Date.now(); }); break; }
      case 'm_trash': S.v.multi = null; return toTrash(list);
      case 'm_restore': S.v.multi = null; return restoreItems(list);
      case 'm_purge': return purgeItems(list);
    }
    log('batch', null, `${{ m_move: '移動分類', m_tag: '加標籤', m_fav: '最愛' }[act]} × ${list.length}`);
    S.v.multi = null; await persist(); renderAll(); toast(`已更新 ${list.length} 個項目`);
  }

  /* ================= 加密附件 ================= */
  function allAttIds() { return S.data ? S.data.entries.flatMap(e => (e.att || []).map(a => a.id)) : []; }
  function ensureDek() {
    if (!S.data.dekId || !S.data.deks[S.data.dekId]) { S.data.dekId = PV.uid(); S.data.deks[S.data.dekId] = PV.newDek(); }
    return S.data.dekId;
  }
  async function addAttachment(e, file) {
    if (file.size > ATT_MAX) return toast(`檔案太大（${fmtSize(file.size)}），上限 10 MB`, 4000);
    const kid = ensureDek(), id = PV.uid();
    const blob = await PV.encBytes(S.data.deks[kid], new Uint8Array(await file.arrayBuffer()));
    await AttStore.put(S.vid, id, blob);
    const meta = { id, name: file.name || '附件', size: file.size, type: file.type || '', kid, at: Date.now() };
    e.att.push(meta); e.updatedAt = Date.now();
    if (Cloud.cfg) { Cloud.cfg.attq = (Cloud.cfg.attq || []).concat(id); await Cloud.save(); }
    log('att_add', e, meta.name);
    await persist(); renderAll(); toast('已加密並附加「' + meta.name + '」');
    return meta;
  }
  async function attBytes(a) {
    let t = await AttStore.get(S.vid, a.id);
    if (!t && Cloud.cfg) {
      toast('從雲端下載附件…', 8000);
      const r = await cloudCall({ a: 'att_get', id: a.id });
      if (!r.ok) throw new Error('雲端找不到這個附件（可能還沒從別台裝置上傳）');
      t = r.data; await AttStore.put(S.vid, a.id, t);
    }
    if (!t) throw new Error('這台裝置沒有這個附件，且沒有連線雲端');
    const k = S.data.deks[a.kid];
    if (!k) throw new Error('缺少附件金鑰（請先同步）');
    return PV.decBytes(k, t);
  }
  async function openAttachment(e, a) {
    try {
      const u8 = await attBytes(a);
      log('att_open', e, a.name); useEntry(e);
      if (/^image\//.test(a.type)) {
        const url = URL.createObjectURL(new Blob([u8], { type: a.type }));
        openModal(`${dh('image', a.name)}<div class="imgprev"><img src="${url}" alt=""></div>
          <div class="btns"><button id="ap_save">${I('download')}另存</button><button class="primary" id="ap_ok">關閉</button></div>`, d => {
          $('#ap_ok', d).onclick = () => { URL.revokeObjectURL(url); closeModal(); };
          $('#ap_save', d).onclick = () => saveBytes(a.name, u8, a.type);
        }, 'wide');
      } else await saveBytes(a.name, u8, a.type);
    } catch (err) { toast('無法開啟附件：' + err.message, 5000); }
  }
  async function dropAtt(id) {
    AttStore.del(S.vid, id).catch(() => {});
    if (Cloud.cfg) { Cloud.cfg.attq = (Cloud.cfg.attq || []).filter(x => x !== id); Cloud.cfg.attdel = (Cloud.cfg.attdel || []).concat(id); Cloud.save(); }
  }
  async function deleteAttachment(e, a) {
    if (!(await confirmBox('刪除附件', `確定刪除「<b>${esc(a.name)}</b>」？`, '刪除', true))) return;
    e.att = e.att.filter(x => x.id !== a.id); e.updatedAt = Date.now();
    dropAtt(a.id); log('att_del', e, a.name);
    await persist(); renderAll();
  }
  function bytesToB64(u8) { return PV.b64(u8); }
  async function saveBytes(name, u8, mime) {
    if (DESKTOP) { const r = await S.api.save_bytes(name, bytesToB64(u8)); if (r) toast('已存到 ' + r, 5000); return; }
    const blob = new Blob([u8], { type: mime || 'application/octet-stream' });
    if (/iPhone|iPad|Android/i.test(navigator.userAgent) && navigator.canShare) {
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (err) { if (err.name === 'AbortError') return; } }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function pickAny(cb) {
    const inp = document.createElement('input'); inp.type = 'file';
    inp.onchange = () => { if (inp.files[0]) cb(inp.files[0]); };
    inp.click();
  }

  /* ================= 密碼產生器 ================= */
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
      const opts = () => { for (const k of ['upper', 'lower', 'digits', 'symbols', 'noAmbig']) g[k] = $('#g_' + k, d).checked; return g; };
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

  /* ================= 快速搜尋（Ctrl+K／桌面版 Ctrl+Alt+P） ================= */
  const pal = { el: null, idx: 0, list: [], hot: false };
  function openPalette(fromHotkey) {
    if (!S.session) { S.pendingPalette = true; toast('請先解鎖'); const p = $('#pw'); if (p) p.focus(); return; }
    closeModal(); closePalette();
    pal.hot = !!fromHotkey; pal.idx = 0;
    const el = document.createElement('div');
    el.className = 'palette-wrap';
    el.innerHTML = `<div class="palette"><div class="pin">${I('search')}<input id="pal_q" placeholder="搜尋項目…" autocomplete="off"><kbd>Esc</kbd></div>
      <div class="plist" id="pal_list"></div>
      <div class="pfoot"><span><kbd>Enter</kbd> 複製密碼</span><span><kbd>Shift Enter</kbd> 複製帳號</span>${DESKTOP ? '<span><kbd>Ctrl Enter</kbd> 自動輸入</span>' : ''}<span><kbd>→</kbd> 開啟</span></div></div>`;
    document.body.appendChild(el); pal.el = el;
    el.onclick = ev => { if (ev.target === el) closePalette(); const r = ev.target.closest('[data-pi]'); if (r) { pal.idx = +r.dataset.pi; palAct('enter'); } };
    const q = $('#pal_q', el);
    q.oninput = () => { pal.idx = 0; palRender(q.value); };
    q.onkeydown = ev => {
      if (ev.isComposing) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); pal.idx = Math.min(pal.idx + 1, pal.list.length - 1); palRender(q.value, true); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); pal.idx = Math.max(pal.idx - 1, 0); palRender(q.value, true); }
      else if (ev.key === 'Enter') { ev.preventDefault(); palAct(ev.ctrlKey ? 'type' : ev.shiftKey ? 'user' : 'enter'); }
      else if (ev.key === 'ArrowRight' && q.selectionStart === q.value.length) { ev.preventDefault(); palAct('open'); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closePalette(); if (pal.hot && DESKTOP) S.api.hide(); }
    };
    palRender('');
    setTimeout(() => q.focus(), 20);
  }
  function closePalette() { if (pal.el) { pal.el.remove(); pal.el = null; } }
  function palRender(q, keep) {
    q = q.trim().toLowerCase();
    let es = live();
    if (q) { const w = q.split(/\s+/); es = es.filter(e => { const h = haystack(e); return w.every(x => h.includes(x)); }); }
    es.sort((a, b) => usageOf(b.id).n - usageOf(a.id).n || (b.fav - a.fav) || a.title.localeCompare(b.title, 'zh-Hant'));
    pal.list = es.slice(0, 40);
    const box = $('#pal_list', pal.el);
    box.innerHTML = pal.list.length ? pal.list.map((e, i) => `<div class="prow ${i === pal.idx ? 'on' : ''}" data-pi="${i}">${avatar(e)}
      <div class="meta"><div class="t">${esc(e.title)}</div><div class="s">${esc(subtitle(e))}</div></div><span class="ptype">${TYPES[e.type].name}</span></div>`).join('')
      : '<div class="empty" style="padding:24px">找不到符合的項目</div>';
    if (keep) { const on = $('.prow.on', box); if (on) on.scrollIntoView({ block: 'nearest' }); }
  }
  async function palAct(kind) {
    const e = pal.list[pal.idx]; if (!e) return;
    if (kind === 'open') { closePalette(); S.v.sel = e.id; S.v.edit = null; S.v.filter = 'all'; renderAll(); return; }
    if (kind === 'type') {
      if (!DESKTOP || e.type !== 'login') return toast('自動輸入只支援桌面版的登入項目');
      closePalette(); return autotype(e, true);
    }
    const [val, label] = kind === 'user' ? [e.username || (e.data || {}).holder || (e.data || {}).fullname, '帳號'] : mainSecret(e);
    if (!val) return toast('這個項目沒有' + label);
    await copy(val, label, e);
    closePalette();
    if (pal.hot && DESKTOP) setTimeout(() => S.api.hide(), 350);
  }
  async function autotype(e, usePrev) {
    const items = [];
    if (e.username) items.push({ t: e.username }, { k: 'tab' });
    items.push({ t: e.password }, { k: 'enter' });
    log('autotype', e); useEntry(e);
    if (soonT) await persist();
    const r = await S.api.autotype(items, !!usePrev, 3);
    if (!r.target) toast('視窗已縮小，3 秒內請點選要輸入的帳號欄位', 3000);
  }

  /* ================= 外洩檢查（Have I Been Pwned，k-匿名） ================= */
  async function breachCheck() {
    const es = live().filter(e => e.type === 'login' && e.password);
    if (!es.length) return toast('沒有可檢查的登入密碼');
    openModal(`${dh('globe', '外洩密碼檢查')}
      <p>會把每組密碼的 SHA-1 雜湊<b>前 5 碼</b>送到 Have I Been Pwned 比對（k-匿名查詢），<b>密碼本身與完整雜湊都不會送出</b>。</p>
      <div class="prog"><i id="bc_bar"></i></div><div class="muted" id="bc_txt" style="font-size:13px;margin-top:6px">準備中…</div>
      <div class="btns"><button class="primary" id="bc_ok" disabled>完成</button></div>`, d => { $('#bc_ok', d).onclick = closeModal; });
    const pws = [...new Set(es.map(e => e.password))], found = {};
    const prefixCache = {};
    let done = 0, fail = 0;
    const base = qs.get('hibp') || 'https://api.pwnedpasswords.com/range/';
    async function check(pw) {
      const h = await PV.hashHex('SHA-1', pw), pre = h.slice(0, 5), suf = h.slice(5);
      try {
        if (!prefixCache[pre]) prefixCache[pre] = fetch(base + pre, { headers: { 'Add-Padding': 'true' }, cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); });
        const txt = await prefixCache[pre];
        const line = txt.split('\n').find(l => l.slice(0, 35).toUpperCase() === suf);
        found[pw] = line ? parseInt(line.split(':')[1], 10) || 0 : 0;
      } catch (err) { fail++; }
      done++;
      const bar = $('#bc_bar'), t = $('#bc_txt');
      if (bar) bar.style.width = (100 * done / pws.length) + '%';
      if (t) t.textContent = `已檢查 ${done} / ${pws.length} 組密碼`;
    }
    const queue = pws.slice();
    await Promise.all([0, 1, 2, 3].map(async () => { while (queue.length) await check(queue.shift()); }));
    const now = Date.now();
    let leak = 0;
    for (const e of es) if (e.password in found) { S.data.breach[e.id] = { n: found[e.password], at: now }; if (found[e.password]) leak++; }
    log('breach', null, `${pws.length} 組，外洩 ${leak} 筆`);
    await persist(); renderAll();
    const t = $('#bc_txt'), ok = $('#bc_ok');
    if (t) t.innerHTML = fail === pws.length ? '<span class="s0">無法連到外洩資料庫（網路問題？）</span>'
      : leak ? `<span class="s0">有 <b>${leak}</b> 個項目的密碼出現在外洩資料中，請盡快更換。</span>${fail ? `（${fail} 組檢查失敗）` : ''}`
        : `<span class="s4">太好了，沒有任何密碼出現在已知外洩資料中。</span>${fail ? `（${fail} 組檢查失敗）` : ''}`;
    if (ok) ok.disabled = false;
    return { checked: pws.length, leak, fail };
  }

  /* ================= 列印：安全報告 / 緊急存取包 ================= */
  function printHtml(title, body) {
    const css = `body{font-family:"Microsoft JhengHei","PingFang TC",sans-serif;color:#0f172a;margin:28px;font-size:12.5px}
      h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 8px;border-bottom:2px solid #2f5bea;padding-bottom:4px}
      .sub{color:#64748b;margin-bottom:14px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e3e8ef;vertical-align:top}
      th{background:#f4f6fa;font-size:11.5px;color:#334155}.kp{display:flex;gap:10px}.kp div{flex:1;border:1px solid #e3e8ef;border-radius:8px;padding:10px}
      .kp b{display:block;font-size:22px}.bad{color:#dc2626}.ok{color:#16a34a}.box{border:1.5px solid #0f172a;border-radius:8px;padding:12px 14px;margin:8px 0}
      .line{border-bottom:1px solid #94a3b8;height:30px;margin:6px 0 2px}.mono{font-family:Consolas,monospace;word-break:break-all}
      .foot{margin-top:24px;color:#94a3b8;font-size:11px}@page{margin:14mm}`;
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    f.srcdoc = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`;
    document.body.appendChild(f);
    f.onload = () => { setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { } setTimeout(() => f.remove(), 60000); }, 150); };
    return f.srcdoc;
  }
  function reportHtml() {
    const st = stats(), es = live(), v = curVault();
    const rows = es.filter(e => e.type === 'login' && e.password).map(e => {
      const issues = [];
      if (breached(e)) issues.push(`已外洩 ${S.data.breach[e.id].n.toLocaleString()} 次`);
      if (PV.strength(e.password).score <= 1) issues.push('弱密碼');
      if (st.pwCount[e.password] > 1) issues.push('重複使用');
      const age = Math.floor((Date.now() - (e.pwAt || e.createdAt)) / 864e5);
      if (age > 365) issues.push(`${age} 天未更換`);
      return { e, issues };
    }).filter(r => r.issues.length);
    const logins = es.filter(e => e.type === 'login' && e.password).length;
    const score = logins ? Math.round(100 * (logins - rows.filter(r => r.issues.some(i => !/天未更換/.test(i))).length) / logins) : 100;
    const cats = Object.entries(st.cats).sort((a, b) => b[1] - a[1]);
    return `<h1>密碼安全報告</h1><div class="sub">保管庫：${esc(v.name)}　·　產生時間：${fmtTime(Date.now())}　·　裝置：${esc(S.dev.name)}　·　本報告不含任何密碼</div>
      <div class="kp"><div>健康分數<b class="${score >= 80 ? 'ok' : 'bad'}">${score}</b></div><div>項目總數<b>${es.length}</b></div><div>已外洩<b class="${st.leak ? 'bad' : ''}">${st.leak}</b></div><div>弱密碼<b class="${st.weak ? 'bad' : ''}">${st.weak}</b></div><div>重複使用<b class="${st.reused ? 'bad' : ''}">${st.reused}</b></div></div>
      <h2>需要處理的項目（${rows.length}）</h2>
      ${rows.length ? `<table><tr><th>名稱</th><th>帳號</th><th>網站</th><th>分類</th><th>問題</th></tr>${rows.map(r => `<tr><td>${esc(r.e.title)}</td><td>${esc(r.e.username)}</td><td>${esc(PV.hostOf(r.e.url))}</td><td>${esc(r.e.category)}</td><td class="bad">${r.issues.join('、')}</td></tr>`).join('')}</table>` : '<p class="ok">沒有需要處理的項目。</p>'}
      <h2>項目類型與分類</h2><table><tr><th>類型</th><th>數量</th></tr>${Object.entries(st.types).map(([t, n]) => `<tr><td>${TYPES[t].name}</td><td>${n}</td></tr>`).join('')}</table>
      ${cats.length ? `<table style="margin-top:10px"><tr><th>分類</th><th>數量</th></tr>${cats.map(([c, n]) => `<tr><td>${esc(c)}</td><td>${n}</td></tr>`).join('')}</table>` : ''}
      <h2>建議</h2><ol>${st.leak ? '<li>已外洩的密碼請優先更換，並在該網站啟用雙重驗證。</li>' : ''}${st.reused ? '<li>重複使用的密碼一旦有一個網站外洩，其他網站都會受影響，請改成各自不同的密碼。</li>' : ''}${st.weak ? '<li>弱密碼請用密碼產生器改成 16 字以上的隨機密碼。</li>' : ''}<li>定期匯出加密備份，並保管好緊急存取包。</li></ol>
      <div class="foot">帳號密碼紀錄 PRO v${VERSION}　·　外洩檢查：${(() => { const t = Math.max(0, ...Object.values(S.data.breach).map(b => b.at)); return t ? fmtTime(t) : '尚未執行'; })()}</div>`;
  }
  function kitHtml(withKey) {
    const v = curVault(), c = Cloud.cfg;
    return `<h1>緊急存取包</h1><div class="sub">保管庫：${esc(v.name)}${v.shared ? '（共用）' : ''}　·　列印時間：${fmtTime(Date.now())}</div>
      <p>請把這張紙收在安全的地方（保險箱、家人知道的位置）。萬一你的電腦或手機遺失，靠這張就能在新裝置取回所有資料。</p>
      <h2>1. 主密碼（請手寫）</h2><div class="box"><div class="line"></div><div style="color:#64748b;font-size:11px">主密碼不會印出來；忘記就無法解開資料。</div></div>
      <h2>2. 雲端資訊</h2>
      ${c ? `<table><tr><th style="width:120px">網頁版</th><td class="mono">https://wu8858009.github.io/pw-vault/</td></tr>
        <tr><th>雲端網址</th><td class="mono">${esc(c.url)}</td></tr>${c.ns ? `<tr><th>保管庫代碼</th><td class="mono">${esc(c.ns)}</td></tr>` : ''}
        <tr><th>同步密碼</th><td class="mono">${withKey ? esc(c.key) : '<div class="line"></div>（請手寫）'}</td></tr>
        ${withKey ? `<tr><th>邀請碼</th><td class="mono" style="font-size:10px">${esc(inviteCode())}</td></tr>` : ''}</table>`
        : '<p class="bad">這個保管庫還沒連線 Google 雲端，資料只存在原本的裝置。建議先連線雲端，或另外保存加密備份檔（.pwvault）。</p>'}
      <h2>3. 在新裝置取回資料</h2><ol><li>電腦：安裝「帳號密碼紀錄.exe」；手機：用瀏覽器開上面的網頁版並加到主畫面。</li>
      <li>在建立畫面按「${v.shared || c && c.ns ? '用邀請碼加入共用保管庫' : '已在別台裝置使用？從 Google 雲端下載'}」，輸入${v.shared || c && c.ns ? '邀請碼' : '雲端網址與同步密碼'}。</li>
      <li>下載後輸入主密碼解鎖。</li></ol>
      <div class="foot">帳號密碼紀錄 PRO　·　AES-256-GCM 端對端加密，沒有主密碼任何人都無法解開</div>`;
  }

  /* ================= 生物辨識解鎖 ================= */
  // 桌面版：主密碼以 Windows DPAPI 保護，解開前必須通過 Windows Hello
  // 手機／瀏覽器：WebAuthn PRF（Face ID／指紋）衍生金鑰加密主密碼，只存在這台裝置
  const Bio = {
    label() { return DESKTOP ? 'Windows Hello' : 'Face ID／指紋'; },
    async status() {
      if (DESKTOP) { const s = await S.api.hello_status(S.vid); return { ok: s.code === 0, msg: s.msg, enrolled: s.enrolled }; }
      const ok = !!(window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false));
      return { ok, msg: ok ? '可用' : '這個瀏覽器或裝置不支援', enrolled: !!(await Local.get('bio.' + S.vid)) };
    },
    async enrolled() {
      try { return DESKTOP ? !!(await S.api.hello_enrolled(S.vid)) : !!(await Local.get('bio.' + S.vid)); } catch (e) { return false; }
    },
    async enroll(pw) {
      if (DESKTOP) { const r = await S.api.hello_enroll(S.vid, pw); if (r !== true) throw new Error(r); return; }
      const salt = PV.rand(32), uid = PV.rand(16);
      const cred = await navigator.credentials.create({ publicKey: {
        rp: { name: '帳號密碼紀錄 PRO' }, user: { id: uid, name: 'pwvault-' + S.vid, displayName: '帳號密碼紀錄：' + curVault().name },
        challenge: PV.rand(32), pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        extensions: { prf: { eval: { first: salt } } }, timeout: 60000 } });
      const ext = cred.getClientExtensionResults().prf;
      if (!ext || ext.enabled === false) throw new Error('這個裝置的生物辨識不支援金鑰衍生（PRF），無法安全保存');
      let out = ext.results && ext.results.first;
      if (!out) out = await Bio._prf(new Uint8Array(cred.rawId), salt);
      const key = await PV.rawKey(new Uint8Array(await crypto.subtle.digest('SHA-256', out)));
      await Local.set('bio.' + S.vid, { cred: PV.b64(new Uint8Array(cred.rawId)), salt: PV.b64(salt), blob: await PV.encText(key, pw) });
    },
    async _prf(rawId, salt) {
      const a = await navigator.credentials.get({ publicKey: { challenge: PV.rand(32), allowCredentials: [{ type: 'public-key', id: rawId }],
        userVerification: 'required', extensions: { prf: { eval: { first: salt } } }, timeout: 60000 } });
      const r = a.getClientExtensionResults().prf;
      if (!r || !r.results || !r.results.first) throw new Error('這個裝置的生物辨識不支援金鑰衍生（PRF）');
      return r.results.first;
    },
    async unlock() {
      if (DESKTOP) { const r = await S.api.hello_unlock(S.vid); if (r.err) throw new Error(r.err); return r.pw; }
      const b = await Local.get('bio.' + S.vid);
      if (!b) throw new Error('尚未啟用');
      const out = await Bio._prf(PV.unb64(b.cred), PV.unb64(b.salt));
      const key = await PV.rawKey(new Uint8Array(await crypto.subtle.digest('SHA-256', out)));
      try { return await PV.decText(key, b.blob); } catch (e) { throw new Error('生物辨識驗證失敗'); }
    },
    async remove() { if (DESKTOP) await S.api.hello_remove(S.vid); else await Local.set('bio.' + S.vid, null); }
  };

  /* ================= 設定與管理 ================= */
  async function openSettings() {
    const st = S.data.settings, v = curVault();
    let where = '本機瀏覽器（此網站的儲存空間）', hk = false;
    if (DESKTOP) { try { const inf = await S.api.info(); where = inf.data_dir; hk = inf.hotkey; } catch (e) { } }
    const bio = await Bio.status().catch(() => ({ ok: false, msg: '無法偵測' }));
    const opt = (vals, cur, unit) => vals.map(x => `<option value="${x}" ${x === cur ? 'selected' : ''}>${x ? x + unit : '永不'}</option>`).join('');
    openModal(`${dh('sliders', '設定與管理')}
      <div class="tabs"><button data-tab="sec" class="on">安全</button><button data-tab="vault">保管庫與共用</button><button data-tab="data">備份與匯入</button><button data-tab="audit">稽核與報告</button></div>
      <div data-pane="sec">
        <section><h4>${I('lock', 'sm')}自動保護</h4>
          <div class="grid2">
            <div><label class="f">閒置自動上鎖</label><select id="s_lock">${opt([1, 3, 5, 10, 15, 30, 60, 0], st.lockMin, ' 分鐘')}</select></div>
            <div><label class="f">複製後清除剪貼簿</label><select id="s_clip">${opt([10, 20, 30, 60, 120, 0], st.clipSec, ' 秒')}</select></div>
          </div>
          <div style="margin-top:12px"><button id="s_chpw">${I('key')}變更主密碼</button></div></section>
        <section><h4>${I('finger', 'sm')}${Bio.label()} 解鎖 ${bio.enrolled ? '<span class="badge ok">已啟用</span>' : ''}</h4>
          <div class="desc">${bio.ok || bio.enrolled ? (DESKTOP ? '主密碼以 Windows 加密保護並綁定這台電腦的帳戶，解鎖前需通過 Windows Hello（臉部、指紋或 PIN）。' : '主密碼用這台裝置的生物辨識金鑰加密，只存在這台裝置，不會同步。') : '目前無法使用：' + esc(bio.msg)}</div>
          ${bio.enrolled ? `<button id="s_bio_off" class="danger">停用</button>` : `<button id="s_bio_on" class="primary" ${bio.ok ? '' : 'disabled'}>${I('finger')}啟用 ${Bio.label()}</button>`}</section>
        <section><h4>${I('user', 'sm')}這台裝置</h4>
          <div class="desc">裝置名稱會出現在稽核紀錄，方便分辨是哪台裝置做的操作。</div>
          <div class="row"><input id="s_dev" value="${esc(S.dev.name)}" maxlength="30"><button id="s_dev_ok">儲存</button></div>
          ${DESKTOP ? `<div class="desc" style="margin:10px 0 0">全域快速鍵 <kbd>Ctrl Alt P</kbd>：${hk ? '<span class="s4">已啟用</span>，在任何程式中按下即可叫出快速搜尋並自動輸入帳密。' : '<span class="s0">無法註冊（可能被其他程式占用）</span>'}</div>` : ''}</section>
      </div>
      <div data-pane="vault" class="hidden">
        <section><h4>${I('vault', 'sm')}目前保管庫：${esc(v.name)} ${v.shared ? '<span class="badge warn">共用</span>' : ''}</h4>
          <div class="row" style="flex-wrap:wrap"><button id="s_vren">${I('edit')}重新命名</button>${v.id !== 'default' ? `<button id="s_vdel" class="danger">${I('trash')}從這台裝置移除</button>` : ''}</div></section>
        <section><h4>${I('cloud', 'sm')}Google 雲端同步 ${Cloud.cfg ? '<span class="badge ok">已連線</span>' : '<span class="badge warn">未連線</span>'}</h4>
          <div class="desc">存在你自己的 Google 試算表，上傳的只有加密後的密文。每個保管庫有自己的同步密碼。</div>
          ${Cloud.cfg ? `<div class="desc" style="color:var(--text-2)">版本 ${Cloud.cfg.rev}${Cloud.cfg.at ? '　·　上次同步 ' + fmtTime(Cloud.cfg.at) : ''}${(Cloud.cfg.attq || []).length ? `　·　${Cloud.cfg.attq.length} 個附件待上傳` : ''}</div>
            <div class="row" style="flex-wrap:wrap"><button id="s_sync">${I('refresh')}立即同步</button><button id="s_unlink" class="danger">中斷連線</button></div>`
          : `<button id="s_link" class="primary">${I('cloud')}連線 Google 雲端</button>`}</section>
        <section><h4>${I('share', 'sm')}共用給同事或家人</h4>
          <div class="desc">產生邀請碼給對方，對方在 App 選「用邀請碼加入共用保管庫」即可。<b>主密碼請另外當面或電話告知</b>，不要和邀請碼放在一起傳。${v.id === 'default' ? '<br>建議另外建立一個「共用保管庫」來分享，不要分享個人保管庫。' : ''}</div>
          <button id="s_invite" ${Cloud.cfg ? '' : 'disabled'}>${I('share')}產生邀請碼</button>${Cloud.cfg ? '' : '<span class="muted" style="font-size:12.5px;margin-left:8px">需先連線雲端</span>'}</section>
        <section><h4>${I('plus', 'sm')}其他保管庫</h4>
          <div class="row" style="flex-wrap:wrap"><button id="s_vnew">${I('plus')}新增保管庫</button><button id="s_vjoin">${I('users')}用邀請碼加入</button></div></section>
      </div>
      <div data-pane="data" class="hidden">
        <section><h4>${I('shield', 'sm')}加密備份</h4>
          <div class="desc">備份檔（.pwvault）以目前的主密碼加密，包含所有附件，可在電腦與手機之間互相匯入。</div>
          <div class="row" style="flex-wrap:wrap"><button id="s_exp">${I('download')}匯出加密備份</button><button id="s_imp">${I('upload')}匯入備份 / CSV</button></div></section>
        <section><h4>${I('printer', 'sm')}緊急存取包</h4>
          <div class="desc">印出一張紙本說明（雲端網址、取回步驟、主密碼手寫欄），收在保險箱，裝置遺失也能取回資料。</div>
          <label class="check"><input type="checkbox" id="s_kitkey"> 一併印出同步密碼與邀請碼（紙本要妥善保管）</label>
          <button id="s_kit">${I('printer')}列印緊急存取包</button></section>
        <section><h4>${I('file', 'sm')}CSV 匯出</h4>
          <div class="desc">支援 Chrome、Edge、Firefox、Bitwarden 格式。CSV 為未加密明文，用完請立即刪除。</div>
          <button id="s_csv" class="danger">${I('download')}匯出 CSV（明文）</button></section>
        <section><h4>${I('info', 'sm')}資料位置</h4><div class="desc" style="overflow-wrap:anywhere;margin:0">${esc(where)}${DESKTOP ? '<br>每天自動在 backups 資料夾保留一份加密備份（最多 30 份）' : '<br>清除瀏覽器網站資料會一併刪除，請定期匯出備份'}</div></section>
      </div>
      <div data-pane="audit" class="hidden">
        <section><h4>${I('activity', 'sm')}稽核紀錄</h4><div class="desc">記錄每次解鎖、檢視機密、複製、修改、匯出等操作（共 ${S.data.audit.length} 筆，加密保存並在裝置間同步）。</div>
          <button id="s_audit">${I('list')}查看稽核紀錄</button></section>
        <section><h4>${I('globe', 'sm')}外洩密碼檢查</h4><div class="desc">比對 Have I Been Pwned 已知外洩密碼資料庫，只送出雜湊前 5 碼。</div>
          <button id="s_breach">${I('globe')}立即檢查</button></section>
        <section><h4>${I('printer', 'sm')}安全報告</h4><div class="desc">列印或另存 PDF：健康分數、需處理項目、分類統計與建議（不含任何密碼）。</div>
          <button id="s_report">${I('printer')}產生安全報告</button></section>
      </div>
      <div class="btns"><button class="primary" id="s_ok">完成</button></div>`, d => {
      const saveOpts = () => { st.lockMin = +$('#s_lock', d).value; st.clipSec = +$('#s_clip', d).value; };
      $$('[data-tab]', d).forEach(b => b.onclick = () => {
        $$('[data-tab]', d).forEach(x => x.classList.toggle('on', x === b));
        $$('[data-pane]', d).forEach(p => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
      });
      const on = (id, fn) => { const el = $('#' + id, d); if (el) el.onclick = () => { saveOpts(); fn(); }; };
      $('#s_ok', d).onclick = async () => { saveOpts(); closeModal(); await persist(); renderAll(); toast('設定已儲存'); };
      on('s_chpw', changeMaster);
      on('s_bio_on', async () => {
        const pw = await promptPw('啟用 ' + Bio.label(), '請輸入目前的主密碼確認身分');
        if (pw == null) return;
        try { await PV.open(await PV.seal(S.session, {}), pw); } catch (e) { return toast('主密碼不正確'); }
        try { await Bio.enroll(pw); log('bio_on'); toast(Bio.label() + ' 解鎖已啟用', 4000); } catch (e) { toast('無法啟用：' + e.message, 6000); }
      });
      on('s_bio_off', async () => { await Bio.remove(); log('bio_off'); closeModal(); toast('已停用生物辨識解鎖'); });
      on('s_dev_ok', async () => { const n = $('#s_dev', d).value.trim(); if (!n) return; S.dev.name = n; await Local.set('device', S.dev); toast('已更新裝置名稱'); });
      on('s_vren', async () => {
        const n = await promptBox('重新命名保管庫', '', { icon: 'edit', value: v.name }); if (!n || !n.trim()) return;
        v.name = n.trim(); await saveVaults(); renderAll(); toast('已重新命名');
      });
      on('s_vdel', async () => {
        if (!(await confirmBox('移除保管庫', `從這台裝置移除「<b>${esc(v.name)}</b>」？${Cloud.cfg ? '雲端資料會保留，之後可用邀請碼或雲端重新下載。' : '<b>這個保管庫沒有連線雲端，移除後資料會消失</b>，請先匯出備份。'}`, '移除', true))) return;
        const id = v.id; lock();
        S.vaults = S.vaults.filter(x => x.id !== id); await Store.remove(id); await Bio.remove().catch(() => {});
        await switchVault(S.vaults[0].id); toast('已移除');
      });
      on('s_link', () => cloudDialog(false));
      on('s_sync', async () => { closeModal(); await syncNow(); toast(S.sync.state === 'ok' ? '同步完成' : '同步失敗：' + S.sync.msg, 4000); });
      on('s_unlink', async () => { if (await confirmBox('中斷雲端連線', '這台裝置將不再同步。雲端和本機的資料都會保留。', '中斷')) { await disconnectCloud(); toast('已中斷連線'); } });
      on('s_invite', inviteDialog);
      on('s_vnew', newVaultDialog);
      on('s_vjoin', joinDialog);
      on('s_exp', exportBackup);
      on('s_imp', () => { closeModal(); pickFile(importFile); });
      on('s_csv', exportCsv);
      on('s_kit', () => { log('kit'); printHtml('緊急存取包', kitHtml($('#s_kitkey', d).checked)); });
      on('s_audit', () => openAudit());
      on('s_breach', () => breachCheck());
      on('s_report', () => { log('report'); printHtml('密碼安全報告', reportHtml()); });
    }, 'wide');
  }
  function vaultMenu() {
    openModal(`${dh('vault', '切換保管庫')}<div class="vlist">${S.vaults.map(v => `<button data-v="${v.id}" class="${v.id === S.vid ? 'on' : ''}">
      <span class="vdot" style="background:${v.color}"></span><span class="lbl">${esc(v.name)}</span>${v.shared ? '<span class="badge warn">共用</span>' : ''}${v.id === S.vid ? I('check', 'sm') : ''}</button>`).join('')}</div>
      <div class="btns"><button id="vm_join">${I('users')}用邀請碼加入</button><button class="primary" id="vm_new">${I('plus')}新增保管庫</button></div>`, d => {
      $$('[data-v]', d).forEach(b => b.onclick = () => { closeModal(); if (b.dataset.v !== S.vid) switchVault(b.dataset.v); });
      $('#vm_new', d).onclick = newVaultDialog;
      $('#vm_join', d).onclick = joinDialog;
    });
  }
  function newVaultDialog() {
    openModal(`${dh('plus', '新增保管庫')}
      <div class="muted">每個保管庫有自己的主密碼與雲端同步，例如把工作和個人分開，或建立和同事、家人共用的保管庫。</div>
      <label class="f">名稱</label><input id="nv_name" placeholder="例如：公司、家庭共用" autofocus maxlength="30">
      <label class="check" style="margin-top:12px"><input type="checkbox" id="nv_shared"> 這是要和別人共用的保管庫</label>
      <div class="btns"><button id="nv_no">取消</button><button class="primary" id="nv_ok">建立</button></div>`, d => {
      $('#nv_no', d).onclick = closeModal;
      $('#nv_ok', d).onclick = async () => {
        const n = $('#nv_name', d).value.trim(); if (!n) return $('#nv_name', d).focus();
        closeModal(); await addVault(n, $('#nv_shared', d).checked);
      };
    });
  }
  function joinDialog() {
    openModal(`${dh('users', '加入共用保管庫')}
      <div class="muted">貼上對方給你的邀請碼（PWV1. 開頭），下載後用對方告訴你的主密碼解鎖。</div>
      <textarea id="jd_code" style="min-height:90px;margin-top:10px" class="mono" placeholder="PWV1.…" autofocus></textarea>
      <div class="err" id="jd_err"></div>
      <div class="btns"><button id="jd_no">取消</button><button class="primary" id="jd_ok">${I('download')}加入</button></div>`, d => {
      $('#jd_no', d).onclick = closeModal;
      $('#jd_ok', d).onclick = async () => {
        $('#jd_ok', d).disabled = true; $('#jd_err', d).textContent = '下載中…';
        try { await joinShared($('#jd_code', d).value); closeModal(); toast('已加入，請輸入共用主密碼解鎖', 4000); }
        catch (e) { $('#jd_ok', d).disabled = false; $('#jd_err', d).textContent = e.message; }
      };
    });
  }
  function inviteDialog() {
    const code = inviteCode();
    log('share');
    openModal(`${dh('share', '邀請加入「' + curVault().name + '」')}
      <div class="notice">${I('alert', 'sm')}<span>持有邀請碼的人可以下載加密資料；<b>還需要主密碼才能打開</b>。請把主密碼用另一個管道告知。</span></div>
      <label class="f">邀請碼</label><textarea readonly class="mono" style="min-height:96px" id="iv_code">${esc(code)}</textarea>
      <div class="btns"><button class="primary" id="iv_cp">${I('copy')}複製邀請碼</button></div>`, d => {
      $('#iv_cp', d).onclick = () => copy(code, '邀請碼');
    });
  }
  async function openAudit(entryId) {
    const all = S.data.audit.slice().reverse();
    openModal(`${dh('activity', entryId ? '這筆的稽核紀錄' : '稽核紀錄')}
      <div class="row" style="gap:8px;flex-wrap:wrap"><div class="input-icon">${I('search', 'sm')}<input id="au_q" placeholder="搜尋項目、裝置…" autocomplete="off"></div>
        <select id="au_a" style="width:auto"><option value="">全部動作</option>${Object.entries(ACT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <button id="au_csv">${I('download')}匯出</button></div>
      <div class="audit" id="au_list"></div>
      <div class="btns"><button class="primary" id="au_ok">關閉</button></div>`, d => {
      const draw = () => {
        const q = $('#au_q', d).value.trim().toLowerCase(), a = $('#au_a', d).value;
        const rows = all.filter(r => (!entryId || r.e === entryId) && (!a || r.a === a) && (!q || [r.n, r.d, r.x, ACT[r.a]].join(' ').toLowerCase().includes(q)));
        $('#au_list', d).innerHTML = rows.length ? `<table><tr><th>時間</th><th>裝置</th><th>動作</th><th>項目</th></tr>${rows.slice(0, 500).map(r =>
          `<tr class="${/fail|purge|export_csv/.test(r.a) ? 'warnrow' : ''}"><td>${fmtTime(r.t)}</td><td>${esc(r.d)}</td><td>${esc(ACT[r.a] || r.a)}${r.x ? `<span class="muted">（${esc(r.x)}）</span>` : ''}</td><td>${esc(r.n || '')}</td></tr>`).join('')}</table>
          ${rows.length > 500 ? `<div class="muted" style="padding:8px;font-size:12px">只顯示最近 500 筆，完整紀錄請匯出。</div>` : ''}` : '<div class="empty">沒有紀錄</div>';
        return rows;
      };
      $('#au_q', d).oninput = draw; $('#au_a', d).onchange = draw;
      $('#au_ok', d).onclick = closeModal;
      $('#au_csv', d).onclick = () => { const rows = draw(); saveOut(`稽核紀錄-${ymd()}.csv`, PV.toCSV([['時間', '裝置', '動作', '說明', '項目']].concat(rows.map(r => [fmtTime(r.t), r.d, ACT[r.a] || r.a, r.x || '', r.n || '']))), 'text/csv'); };
      draw();
    }, 'wide');
  }

  // download=true：還沒有本機密碼庫，直接從雲端下載（新手機 / 新電腦）
  function cloudDialog(download) {
    const preset = (window.PV_CLOUD_URL || '').trim();
    openModal(`${dh('cloud', download ? '從 Google 雲端下載' : '連線 Google 雲端')}
      <div class="muted" style="font-size:13px">${download
        ? '輸入雲端網址和同步密碼，下載後再用主密碼解鎖。'
        : '第一次連線時輸入的同步密碼會成為這個保管庫的同步密碼，其他裝置要輸入同一組。<br>同步密碼只用來存取雲端，主密碼仍然只有你知道。'}</div>
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
            if (S.vid !== 'default') cfg.ns = S.vid;
            const l = await cloudCall({ a: 'load' }, cfg);
            if (!l.vault) throw Object.assign(new Error('雲端還沒有資料'), { empty: true });
            await Store.save(l.vault);
            cfg.rev = l.rev; cfg.at = Date.now(); Cloud.cfg = cfg; await Cloud.save(); await saveVaults();
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
      <div class="err" id="cerr"></div>
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
    log('master');
    await persist();
    if (await Bio.enrolled()) { await Bio.remove(); setTimeout(() => toast('主密碼已變更，生物辨識解鎖需要重新啟用', 5000), 5200); }
    return true;
  }

  /* ================= 匯入 / 匯出 ================= */
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
  async function backupText() {
    const blobs = {};
    for (const e of S.data.entries) for (const a of e.att || []) {
      let t = await AttStore.get(S.vid, a.id);
      if (!t && Cloud.cfg) { try { const r = await cloudCall({ a: 'att_get', id: a.id }); if (r.ok) t = r.data; } catch (err) { } }
      if (t) blobs[a.id] = t;
    }
    return PV.seal(S.session, Object.assign({}, S.data, { _attBlobs: blobs }));
  }
  async function exportBackup() {
    log('export');
    await saveOut(`帳號密碼備份-${curVault().name}-${ymd()}.pwvault`, await backupText(), 'application/octet-stream');
  }
  async function exportCsv() {
    if (!(await confirmBox('匯出 CSV', 'CSV 是<b>沒有加密的明文</b>，任何人拿到檔案都看得到所有密碼。<br>用完請立即刪除。確定匯出？', '我了解，匯出', true))) return;
    log('export_csv');
    await saveOut(`帳號密碼-${ymd()}.csv`, PV.toCSV(PV.entriesToRows(live().filter(e => e.type === 'login'))), 'text/csv');
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
      if ((x.type || 'login') === 'login' && keys.has(dupKey(x))) { skipped++; continue; }
      const e = newEntry(byId ? x : Object.assign({}, x, { id: undefined }));
      if (!e.id) e.id = PV.uid();
      S.data.entries.push(e); keys.add(dupKey(e)); added++;
    }
    defaults(S.data);
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
      const od = opened.data;
      Object.assign(S.data.deks, od.deks || {});
      for (const id in od._attBlobs || {}) {
        await AttStore.put(S.vid, id, od._attBlobs[id]);
        if (Cloud.cfg) Cloud.cfg.attq = (Cloud.cfg.attq || []).concat(id);
      }
      r = await mergeEntries(defaults(od).entries, true);
    } else {
      const list = PV.rowsToEntries(PV.parseCSV(text));
      if (!list.length) return toast('CSV 裡沒有可匯入的資料', 4000);
      r = await mergeEntries(list, false);
    }
    log('import', null, `${name || ''}：新增 ${r.added}、更新 ${r.updated}`);
    S.v.filter = 'all'; renderAll();
    openModal(`${dh('check', '匯入完成')}<p>新增 <b>${r.added}</b> 筆${r.updated ? `、更新 ${r.updated} 筆` : ''}、略過重複 ${r.skipped} 筆。</p>
      ${/\.csv$/i.test(name || '') ? `<div class="notice">${I('alert', 'sm')}<span>請記得刪除剛才的 CSV 檔（它沒有加密）。</span></div>` : ''}
      <div class="btns"><button class="primary" id="ok" autofocus>好</button></div>`, d => { $('#ok', d).onclick = closeModal; });
    return r;
  }

  /* ================= 事件 ================= */
  app.addEventListener('click', async ev => {
    const fEl = ev.target.closest('[data-f]');
    if (fEl) { S.v.filter = fEl.dataset.f; S.v.sideOpen = false; S.v.sel = null; S.v.edit = null; if (S.v.multi) S.v.multi = new Set(); renderAll(); return; }
    const it = ev.target.closest('.item[data-id], .fr.link[data-id]');
    if (it) {
      const id = it.dataset.id;
      if (S.v.multi || (ev.ctrlKey && it.classList.contains('item'))) {
        S.v.multi = S.v.multi || new Set();
        S.v.multi.has(id) ? S.v.multi.delete(id) : S.v.multi.add(id);
        renderList(); return;
      }
      if (S.v.edit) readEdit();
      S.v.sel = id; S.v.edit = null; S.v.showPw = false; renderAll(); return;
    }
    const b = ev.target.closest('[data-act]'); if (!b || !S.data) return;
    ev.preventDefault();
    const e = cur(), act = b.dataset.act;
    if (act.startsWith('m_') && act !== 'm_on') return batch(act);
    switch (act) {
      case 'menu': S.v.sideOpen = !S.v.sideOpen; layoutClass(); break;
      case 'vaults': vaultMenu(); break;
      case 'palette': openPalette(); break;
      case 'new': typePicker(); break;
      case 'm_on': S.v.multi = new Set(); S.v.sel = null; renderAll(); break;
      case 'edit': S.v.edit = JSON.parse(JSON.stringify(e)); renderAll(); break;
      case 'dup': S.v.edit = newEntry(Object.assign(JSON.parse(JSON.stringify(e)), { id: PV.uid(), title: e.title + '（副本）', history: [], att: [], createdAt: Date.now() })); renderAll(); break;
      case 'cancel': S.v.edit = null; S.v.showPw = false; renderAll(); break;
      case 'save': await saveEdit(); break;
      case 'back': S.v.sel = null; renderAll(); break;
      case 'eye': S.v.showPw = !S.v.showPw; if (S.v.showPw) log('view', e); renderDetail(); break;
      case 'eye2': { const p = $('#e_password'); S.v.showPw = p.type === 'password'; p.type = S.v.showPw ? 'text' : 'password'; break; }
      case 'eye3': { const p = b.parentElement.querySelector('input'); p.type = p.type === 'password' ? 'text' : 'password'; break; }
      case 'quickgen': setEditPw(PV.generate(S.data.settings.gen)); break;
      case 'gen2': openGenerator(setEditPw); break;
      case 'gen': openGenerator(); break;
      case 'cf_add': { readEdit(); S.v.edit.fields.push({ n: '', v: '', s: false }); $('#cflist').innerHTML = cfRows(S.v.edit); const ins = $$('.cf_n'); ins[ins.length - 1].focus(); break; }
      case 'cf_del': readEdit(); S.v.edit.fields.splice(+b.dataset.i, 1); $('#cflist').innerHTML = cfRows(S.v.edit); break;
      case 'cp': {
        const k = b.dataset.f2;
        if (k) copy(e[k], { username: '帳號', password: '密碼', url: '網址', notes: k === 'notes' && e.type === 'note' ? '內容' : '備註' }[k], e);
        else if (b.dataset.d) { const f = TYPES[e.type].fields.find(x => x.k === b.dataset.d); copy(e.data[b.dataset.d], f ? f.l : '', e); }
        else if (b.dataset.cf) { const f = e.fields[+b.dataset.cf]; copy(f.v, f.n || '欄位', e); }
        break;
      }
      case 'cph': copy(e.history[+b.dataset.i].pw, '舊密碼', e); break;
      case 'open': openUrl(e.url, e); break;
      case 'autotype': autotype(e, false); break;
      case 'fav': e.fav = !e.fav; e.updatedAt = Date.now(); await persist(); renderAll(); break;
      case 'del': await toTrash([e]); break;
      case 'restore': await restoreItems([e]); break;
      case 'purge': await purgeItems([e]); break;
      case 'emptytrash': await purgeItems(S.data.entries.filter(x => x.trashedAt)); break;
      case 'att_add': pickAny(f => addAttachment(e, f)); break;
      case 'att_open': { const a = e.att.find(x => x.id === b.dataset.a); if (a) openAttachment(e, a); break; }
      case 'att_del': { const a = e.att.find(x => x.id === b.dataset.a); if (a) deleteAttachment(e, a); break; }
      case 'audit': openAudit(); break;
      case 'audit_item': openAudit(e.id); break;
      case 'breach': breachCheck(); break;
      case 'report': log('report'); printHtml('密碼安全報告', reportHtml()); break;
      case 'settings': openSettings(); break;
      case 'cloudset': cloudDialog(false); break;
      case 'syncnow': syncNow(); break;
      case 'lock': lock(); break;
    }
  });
  document.addEventListener('keydown', ev => {
    S.lastAct = Date.now();
    if (!S.data) return;
    if (pal.el) return;
    const k = ev.key.toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
    if (mod && k === 'l') { ev.preventDefault(); lock(); }
    else if (mod && k === 'k') { ev.preventDefault(); openPalette(); }
    else if (mod && k === 'f') { ev.preventDefault(); closeModal(); const q = $('#q'); if (q) { q.focus(); q.select(); } }
    else if (mod && k === 'n') { ev.preventDefault(); typePicker(); }
    else if (mod && k === 'g') { ev.preventDefault(); if (modal.classList.contains('hidden')) openGenerator(S.v.edit ? setEditPw : null); }
    else if (mod && k === 's' && S.v.edit) { ev.preventDefault(); saveEdit(); }
    else if (k === 'escape') {
      if (!modal.classList.contains('hidden')) closeModal();
      else if (S.v.multi) { S.v.multi = null; renderList(); }
      else if (S.v.edit) { S.v.edit = null; renderAll(); }
      else if (S.v.sideOpen) { S.v.sideOpen = false; layoutClass(); }
    }
  });
  window.__pvPalette = () => openPalette(true);
  for (const t of ['pointerdown', 'pointermove', 'wheel', 'touchstart']) document.addEventListener(t, () => { S.lastAct = Date.now(); }, { passive: true });
  function idleCheck() {
    if (!S.session) return;
    const m = S.data.settings.lockMin;
    if (m > 0 && Date.now() - S.lastAct > m * 60000) lock(`閒置 ${m} 分鐘，已自動上鎖`);
  }
  setInterval(idleCheck, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (S.session && Cloud.cfg && (Cloud.cfg.dirty || soonT)) persist().then(syncNow).catch(() => {}); return; }
    idleCheck();
    if (S.session && Cloud.cfg) syncNow();
  });
  // 每 30 秒檢查雲端有沒有別台裝置的新版本（只查版本號，很省流量）
  setInterval(() => { if (S.session && Cloud.cfg && !document.hidden && !SELFTEST) syncNow(); }, 30000);

  /* ================= 自我測試 ================= */
  async function selftest() {
    const R = { version: VERSION, desktop: DESKTOP, steps: [], ok: true };
    const step = (name, ok, info) => { R.steps.push({ name, ok: !!ok, info }); if (!ok) R.ok = false; if (DESKTOP) S.api.kv_set('__selftest', name); };
    const wait = ms => new Promise(r => setTimeout(r, ms));
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
      let st = stats();
      step('安全檢查（弱密碼）', st.weak === 1, st.weak);
      S.v.q = '網銀'; step('搜尋備註', filtered(st).length === 1); S.v.q = '';

      // 項目類型 + 自訂欄位
      startNew('card');
      $('#e_title').value = '玉山卡'; $('#d_number').value = '4111 1111 1111 1234'; $('#d_cvv').value = '987'; $('#d_bank').value = '玉山';
      S.v.edit.fields.push({ n: '', v: '', s: false }); $('#cflist').innerHTML = cfRows(S.v.edit);
      $('.cf_n').value = '網銀代號'; $('.cf_v').value = 'ESUN-777'; $('.cf_s').checked = true;
      await saveEdit();
      const card = S.data.entries.find(e => e.type === 'card');
      step('信用卡類型與自訂欄位', card && card.data.number === '4111 1111 1111 1234' && card.fields[0].v === 'ESUN-777' && card.fields[0].s && subtitle(card) === '玉山 •••• 1234');
      step('機密欄位不在搜尋範圍', (S.v.q = '987', filtered(stats()).length === 0) && (S.v.q = '玉山', filtered(stats()).length === 1)); S.v.q = '';
      S.v.sel = card.id; renderAll();
      step('信用卡詳細頁遮蔽卡號', !$('#detail').textContent.includes('4111') && $('#detail').textContent.includes('卡號'));
      startNew('note'); $('#e_title').value = '保險箱'; $('#e_notes').value = '左3右7左9'; await saveEdit();
      step('安全筆記', S.data.entries.some(e => e.type === 'note' && e.notes === '左3右7左9'));

      // 使用統計與稽核
      await copy('x', '密碼', g); await copy('x', '密碼', g);
      step('使用統計', usageOf(g.id).n === 2);
      step('稽核紀錄', S.data.audit.some(a => a.a === 'copy' && a.e === g.id) && S.data.audit.some(a => a.a === 'create'));

      // 批次與回收桶
      const fb = S.data.entries.find(e => e.title === 'Facebook'), bank = S.data.entries.find(e => e.title === '銀行');
      S.v.multi = new Set([fb.id, bank.id]);
      const pb = promptBox; promptBox = async () => '社群'; await batch('m_move'); promptBox = pb;
      step('批次移動分類', fb.category === '社群' && bank.category === '社群' && S.v.multi === null);
      await toTrash([fb]);
      st = stats();
      step('移到回收桶', fb.trashedAt && st.trash === 1 && !filtered(st).includes(fb) && st.weak === 0);
      await restoreItems([fb]);
      step('從回收桶還原', !fb.trashedAt && stats().trash === 0);
      fb.trashedAt = Date.now() - 31 * 864e5; purgeTrash();
      step('回收桶超過 30 天自動清除', !S.data.entries.includes(fb) && S.data.deleted[fb.id]);

      // 附件
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
      const att = await addAttachment(bank, new File([png], '證件.png', { type: 'image/png' }));
      const back = await attBytes(att);
      step('加密附件存取', back.length === png.length && back.every((x, i) => x === png[i]));
      const raw = await AttStore.get(S.vid, att.id);
      step('附件以密文保存', raw && !raw.includes('PNG') && !raw.includes('iVBOR'));

      const file = await Store.load();
      step('存檔不含明文', file && !file.includes('New-Pass-2') && !file.includes('facebook') && !file.includes('4111'));
      const backup = await backupText();
      lock();
      step('上鎖清除記憶體', S.data === null && !!$('#pw'));
      step('錯誤主密碼被拒', (await unlock('wrong')) !== true);
      step('正確主密碼解鎖', (await unlock('Test-主密碼-123')) === true && live().length === 4, live().length);
      step('解鎖失敗寫入稽核', S.data.audit.some(a => a.a === 'unlock_fail'));
      step('變更主密碼', (await changeMasterTo('Test-主密碼-123', 'New-主密碼-456')) === true);
      lock();
      step('新主密碼解鎖', (await unlock('New-主密碼-456')) === true);
      const bankAtt = S.data.entries.find(e => e.title === '銀行').att[0];
      step('換主密碼後附件仍可讀', (await attBytes(bankAtt)).length === png.length);

      // 備份含附件：刪掉本機附件後從備份還原
      await AttStore.del(S.vid, bankAtt.id);
      S.data.entries = S.data.entries.filter(e => e.type === 'login').slice(0, 1);
      await persist();
      const ob = await PV.open(backup, 'Test-主密碼-123');
      for (const id in ob.data._attBlobs) await AttStore.put(S.vid, id, ob.data._attBlobs[id]);
      Object.assign(S.data.deks, ob.data.deks);
      const r2 = await mergeEntries(defaults(ob.data).entries, true); closeModal();
      step('匯入加密備份（含附件）', r2.added === 3 && (await attBytes(S.data.entries.find(e => e.title === '銀行').att[0])).length === png.length, r2);

      // 快速搜尋
      openPalette(); const q = $('#pal_q'); q.value = '玉山'; q.oninput();
      step('快速搜尋', pal.list.length === 1 && pal.list[0].type === 'card'); closePalette();

      // 報告與緊急存取包不含機密
      const rep = reportHtml(), kit = kitHtml(false);
      step('安全報告不含密碼', rep.includes('密碼安全報告') && !rep.includes('New-Pass-2') && !rep.includes('4111'));
      step('緊急存取包', kit.includes('主密碼') && !kit.includes('New-主密碼'));

      // 外洩檢查（用假的 HIBP 回應）
      if (qs.get('hibp')) {
        const res = await breachCheck(); closeModal();
        step('外洩檢查', res.checked >= 1 && S.data.entries.some(e => breached(e)), res);
      }

      if (DESKTOP) {
        await S.api.copy('clip-test', 2);
        step('剪貼簿複製', (await S.api.clip_text()) === 'clip-test');
        await wait(3200);
        step('剪貼簿自動清除', (await S.api.clip_text()) === '');
      }

      const curl = qs.get('cloud');
      if (curl) {
        await connectCloud(curl, 'sync-key-123');
        let bad = false;
        try { await cloudCall({ a: 'rev' }, { url: curl, key: 'wrong-key' }); } catch (e) { bad = e.message === '同步密碼錯誤'; }
        step('雲端連線並上傳', S.sync.state === 'ok' && Cloud.cfg.rev >= 1 && !Cloud.cfg.dirty, Cloud.cfg.rev);
        step('雲端同步密碼錯誤被拒', bad);
        step('附件上傳雲端', !(Cloud.cfg.attq || []).length && (await cloudCall({ a: 'att_get', id: S.data.entries.find(e => e.title === '銀行').att[0].id })).ok);
        const l1 = await cloudCall({ a: 'load' });
        const b = await PV.openWith(l1.vault, S.session);
        const victim = b.entries.find(e => e.title === 'Google');
        b.entries = b.entries.filter(e => e !== victim);
        b.deleted = Object.assign(b.deleted || {}, { [victim.id]: Date.now() });
        b.entries.push(newEntry({ title: 'FromB', password: 'b-Pass-778899' }));
        b.audit.push({ i: 'auditFromB', t: Date.now(), d: '裝置B', a: 'create', n: 'FromB' });
        const sb = await cloudCall({ a: 'save', baseRev: l1.rev, vault: await PV.seal(S.session, b) });
        S.data.entries.push(newEntry({ title: 'FromA', password: 'a-Pass-112233' }));
        await persist();
        await syncNow();
        const titles = live().map(e => e.title).sort().join(',');
        step('衝突合併（本機）', sb.ok && titles.includes('FromA') && titles.includes('FromB') && !titles.includes('Google'), titles);
        step('稽核紀錄跨裝置合併', S.data.audit.some(a => a.i === 'auditFromB'));
        const l2 = await cloudCall({ a: 'load' });
        const rt = (await PV.openWith(l2.vault, S.session)).entries.filter(e => !e.trashedAt).map(e => e.title).sort().join(',');
        step('衝突合併（雲端）', rt === titles && !Cloud.cfg.dirty && l2.rev === Cloud.cfg.rev, l2.rev);
        step('雲端只有密文', !l2.vault.includes('FromA') && !l2.vault.includes('Pass'));

        // 共用保管庫：新增 → 連線（獨立命名空間與同步密碼）→ 邀請碼 → 另一個「裝置」加入
        const mainVid = S.vid;
        await addVault('團隊共用', true);
        step('新增保管庫並切換', S.vid !== mainVid && !S.session && $('#p1'));
        await createVault('Team-主密碼-999');
        S.v.edit = newEntry({ title: '公司 VPN', username: 'team', password: 'Vpn-Team-2026!' }); renderAll(); await saveEdit();
        await connectCloud(curl, 'team-sync-key');
        step('共用保管庫獨立雲端', Cloud.cfg.ns === S.vid && Cloud.cfg.rev >= 1);
        const code = inviteCode(), teamVid = S.vid;
        step('邀請碼', /^PWV1\./.test(code) && parseInvite(code).ns === teamVid);
        let isolated = false;
        try { await cloudCall({ a: 'load' }, { url: curl, key: 'team-sync-key' }); } catch (e) { isolated = e.message === '同步密碼錯誤'; }
        step('個人保管庫不能用共用同步密碼開啟', isolated);
        // 模擬另一台裝置：移除本機後用邀請碼加入
        lock(); S.vaults = S.vaults.filter(v => v.id !== teamVid); await Store.remove(teamVid);
        await joinShared(code);
        step('用邀請碼加入', S.vid === teamVid && !!(await Store.load()) && curVault().shared);
        step('共用主密碼解鎖', (await unlock('Team-主密碼-999')) === true && live().some(e => e.title === '公司 VPN'));
        await switchVault(mainVid);
        step('切回個人保管庫', S.vid === mainVid && (await unlock('New-主密碼-456')) === true && !live().some(e => e.title === '公司 VPN'));
      }
      S.data.settings.lockMin = 1; S.lastAct = Date.now() - 61000; idleCheck();
      step('閒置自動上鎖', S.session === null);
      step('最終存檔可用新密碼開啟', !!(await PV.open(await Store.load(), 'New-主密碼-456')).data.entries.length);
    } catch (e) { step('例外', false, String(e && e.stack || e)); }
    window.__selftest = R;
    if (DESKTOP) await S.api.selftest_done(JSON.stringify(R));
    else console.log('SELFTEST', JSON.stringify(R));
  }

  /* ================= 啟動 ================= */
  async function boot() {
    if (DESKTOP) S.api = await apiReady();
    if (!DESKTOP && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
    if (!window.crypto || !crypto.subtle) {
      app.innerHTML = '<div class="center">此瀏覽器不支援加密功能（需 https 或本機網址）。</div>';
      return;
    }
    await loadDevice();
    await loadVaults();
    await Cloud.load();
    if (SELFTEST) return selftest();
    (await Store.load()) ? renderUnlock() : renderSetup();
  }
  boot();
})();
