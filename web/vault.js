/* 帳號密碼紀錄系統 — 加密核心（瀏覽器與 Node 共用）
 * 檔案格式：{app:"PwVault", v:1, kdf:{name:"PBKDF2-SHA256", iter, salt}, iv, ct}
 *   金鑰 = PBKDF2-SHA256(主密碼, salt, iter) → AES-256-GCM
 *   AAD  = "PwVault/1/PBKDF2-SHA256/<iter>/<salt>"（綁住檔頭，竄改即解不開）
 */
(function (root) {
  'use strict';
  const cr = root.crypto || globalThis.crypto;
  const subtle = cr.subtle;
  const te = new TextEncoder(), td = new TextDecoder();
  const ITER = 600000;

  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) {
    const bin = atob(s), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function rand(n) { const u = new Uint8Array(n); cr.getRandomValues(u); return u; }
  function aad(iter, salt) { return te.encode('PwVault/1/PBKDF2-SHA256/' + iter + '/' + salt); }

  async function deriveKey(password, saltB64, iter) {
    const base = await subtle.importKey('raw', te.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: iter },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // session = {key, salt, iter}；每次存檔換新 IV
  async function seal(session, data) {
    const iv = rand(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(session.iter, session.salt) },
      session.key, te.encode(JSON.stringify(data)));
    return JSON.stringify({
      app: 'PwVault', v: 1,
      kdf: { name: 'PBKDF2-SHA256', iter: session.iter, salt: session.salt },
      iv: b64(iv), ct: b64(new Uint8Array(ct))
    });
  }

  async function newSession(password, iter) {
    const salt = b64(rand(16)), it = iter || ITER;
    return { key: await deriveKey(password, salt, it), salt, iter: it };
  }

  function parseFile(text) {
    let f;
    try { f = JSON.parse(text); } catch (e) { throw new Error('NOT_VAULT'); }
    if (!f || f.app !== 'PwVault' || !f.kdf || !f.iv || !f.ct) throw new Error('NOT_VAULT');
    if (f.v !== 1) throw new Error('BAD_VERSION');
    return f;
  }
  function isVaultText(text) { try { parseFile(text); return true; } catch (e) { return false; } }

  // 回傳 {session, data}；密碼錯誤丟 BAD_PASSWORD
  async function open(text, password) {
    const f = parseFile(text);
    const session = { key: await deriveKey(password, f.kdf.salt, f.kdf.iter), salt: f.kdf.salt, iter: f.kdf.iter };
    let pt;
    try {
      pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.iv), additionalData: aad(f.kdf.iter, f.kdf.salt) },
        session.key, unb64(f.ct));
    } catch (e) { throw new Error('BAD_PASSWORD'); }
    return { session, data: JSON.parse(td.decode(pt)) };
  }

  // 用已解鎖的金鑰開另一份檔案；salt/iter 不同（別台改過主密碼）回傳 null
  async function openWith(text, session) {
    const f = parseFile(text);
    if (f.kdf.salt !== session.salt || f.kdf.iter !== session.iter) return null;
    let pt;
    try {
      pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.iv), additionalData: aad(f.kdf.iter, f.kdf.salt) },
        session.key, unb64(f.ct));
    } catch (e) { return null; }
    return JSON.parse(td.decode(pt));
  }

  // 合併兩份資料：同 id 取 updatedAt 較新者；deleted = {id: 刪除時間} 墓碑；設定以 local 為準
  const TOMB_DAYS = 365;
  function merge(local, remote) {
    const deleted = {};
    for (const d of [remote.deleted || {}, local.deleted || {}])
      for (const id in d) deleted[id] = Math.max(deleted[id] || 0, d[id]);
    const map = new Map();
    for (const e of (remote.entries || []).concat(local.entries || [])) {
      const o = map.get(e.id);
      if (!o || (e.updatedAt || 0) > (o.updatedAt || 0)) map.set(e.id, e);
    }
    const cut = Date.now() - TOMB_DAYS * 864e5;
    for (const id in deleted) if (deleted[id] < cut) delete deleted[id];
    const entries = [...map.values()].filter(e => !(deleted[e.id] && deleted[e.id] >= (e.updatedAt || 0)));
    return Object.assign({}, remote, local, { entries, deleted });
  }
  function sameEntries(a, b) {
    const k = d => JSON.stringify((d.entries || []).map(e => e.id + ':' + e.updatedAt).sort()) + JSON.stringify(Object.keys(d.deleted || {}).sort());
    return k(a) === k(b);
  }

  /* ---------- 密碼產生器 ---------- */
  const SETS = {
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lower: 'abcdefghijklmnopqrstuvwxyz',
    digits: '0123456789',
    symbols: '!@#$%^&*()-_=+[]{};:,.?/~'
  };
  const AMBIG = 'Il1O0o|';
  function randInt(n) {
    const lim = Math.floor(0x100000000 / n) * n, u = new Uint32Array(1);
    do cr.getRandomValues(u); while (u[0] >= lim);
    return u[0] % n;
  }
  function generate(opt) {
    opt = Object.assign({ length: 16, upper: true, lower: true, digits: true, symbols: true, noAmbig: true }, opt || {});
    const len = Math.max(4, Math.min(128, opt.length | 0));
    const sets = Object.keys(SETS).filter(k => opt[k]).map(k =>
      opt.noAmbig ? [...SETS[k]].filter(c => !AMBIG.includes(c)).join('') : SETS[k]);
    if (!sets.length) sets.push(SETS.lower);
    const pool = sets.join('');
    for (let tries = 0; ; tries++) {
      let pw = '';
      for (let i = 0; i < len; i++) pw += pool[randInt(pool.length)];
      if (tries > 200 || len < sets.length || sets.every(s => [...pw].some(c => s.includes(c)))) return pw;
    }
  }

  const COMMON = ['password', '123456', '12345678', '123456789', 'qwerty', 'abc123', '111111', '000000', 'iloveyou',
    'admin', 'welcome', 'password1', '1234', '12345', 'qwer1234', 'aa123456', 'a123456', '888888', '666666', '520520'];
  // 回傳 {bits, score 0-4, label}
  function strength(pw) {
    pw = pw || '';
    if (!pw) return { bits: 0, score: 0, label: '空白' };
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/[0-9]/.test(pw)) pool += 10;
    if (/[^A-Za-z0-9]/.test(pw)) pool += /[^\x00-\x7f]/.test(pw) ? 100 : 33;
    // 重複字元與連續序列打折
    let eff = 0, prev = '', run = 0;
    for (const c of pw) {
      const seq = prev && Math.abs(c.charCodeAt(0) - prev.charCodeAt(0)) <= 1;
      run = seq ? run + 1 : 0;
      eff += run >= 2 ? 0.25 : 1;
      prev = c;
    }
    const uniq = new Set(pw).size;
    eff = Math.min(eff, uniq * 2);
    let bits = eff * Math.log2(Math.max(pool, 2));
    if (COMMON.includes(pw.toLowerCase())) bits = Math.min(bits, 8);
    const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
    return { bits: Math.round(bits), score, label: ['非常弱', '弱', '普通', '強', '非常強'][score] };
  }

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = ''; rows.push(row); row = [];
      } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim() !== ''));
  }
  function toCSV(rows) {
    return '﻿' + rows.map(r => r.map(v => {
      v = v == null ? '' : String(v);
      return /[",\r\n]/.test(v) || /^[=+\-@]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(',')).join('\r\n') + '\r\n';
  }

  const COLS = {
    title: ['name', 'title', '名稱', '標題', '項目'],
    url: ['url', 'login_uri', 'website', 'web site', '網址', '網站'],
    username: ['username', 'login_username', 'user', 'user name', 'email', 'login', '帳號', '使用者名稱'],
    password: ['password', 'login_password', '密碼'],
    notes: ['note', 'notes', 'extra', 'comments', 'comment', '備註'],
    category: ['folder', 'grouping', 'category', 'group', '分類', '資料夾'],
    tags: ['tags', 'tag', '標籤'],
    fav: ['favorite', 'fav', '最愛']
  };
  function hostOf(url) {
    try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./, ''); }
    catch (e) { return ''; }
  }
  // 由 CSV 列轉成項目（Chrome / Edge / Firefox / Bitwarden / 本系統匯出）
  function rowsToEntries(rows) {
    if (rows.length < 2) return [];
    const head = rows[0].map(h => h.trim().toLowerCase());
    const idx = {};
    for (const k in COLS) idx[k] = head.findIndex(h => COLS[k].includes(h));
    if (idx.password < 0 && idx.username < 0) throw new Error('CSV 找不到「username / password」欄位');
    const get = (r, k) => idx[k] >= 0 ? (r[idx[k]] || '').trim() : '';
    return rows.slice(1).map(r => {
      const url = get(r, 'url');
      const e = {
        title: get(r, 'title') || hostOf(url) || get(r, 'username') || '(未命名)',
        url, username: get(r, 'username'), password: idx.password >= 0 ? (r[idx.password] || '') : '',
        notes: get(r, 'notes'), category: get(r, 'category'),
        tags: get(r, 'tags').split(/[,，;；]/).map(s => s.trim()).filter(Boolean),
        fav: /^(1|true|yes|是)$/i.test(get(r, 'fav'))
      };
      return e;
    }).filter(e => e.username || e.password || e.url);
  }
  function entriesToRows(entries) {
    return [['name', 'url', 'username', 'password', 'note', 'category', 'tags', 'favorite']].concat(
      entries.map(e => [e.title, e.url, e.username, e.password, e.notes, e.category, (e.tags || []).join(', '), e.fav ? '1' : '']));
  }

  function uid() { return Date.now().toString(36) + b64(rand(6)).replace(/[+/=]/g, ''); }

  const api = { ITER, seal, open, openWith, merge, sameEntries, newSession, parseFile, isVaultText, generate, strength, parseCSV, toCSV,
    rowsToEntries, entriesToRows, hostOf, uid, b64, unb64 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PV = api;
})(typeof window !== 'undefined' ? window : globalThis);
