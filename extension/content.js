/* 網頁內：找登入欄位、顯示帳號清單、填入、登入後詢問是否儲存。
 * 所有介面都放在封閉的 Shadow DOM 裡，網頁的程式讀不到清單內容。 */
(() => {
  'use strict';
  if (window.__pvContent) return;
  window.__pvContent = true;
  // 不在帳號密碼紀錄自己的網頁版裡動作（避免記錄主密碼）
  if (/帳號密碼紀錄系統/.test(document.title) || document.querySelector('meta[name="apple-mobile-web-app-title"][content="帳號密碼"]')) return;

  const ask = msg => new Promise(res => { try { chrome.runtime.sendMessage(msg, r => res(chrome.runtime.lastError ? { ok: false, err: 'NO_EXT' } : r)); } catch (e) { res({ ok: false, err: 'NO_EXT' }); } });
  const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const pwFields = () => [...document.querySelectorAll('input[type=password]')].filter(el => !el.disabled && !el.readOnly && visible(el));
  const textLike = el => el.tagName === 'INPUT' && /^(text|email|tel|number|)$/i.test(el.type || '') && !el.disabled && !el.readOnly && visible(el);

  // 欄位旁邊的文字：label、placeholder、name、aria-label，或表格裡前一格的文字（像「門市：」）
  function labelText(el) {
    const parts = [el.getAttribute('aria-label'), el.placeholder, el.name, el.id, el.title];
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) parts.push(l.textContent); }
    const pl = el.closest('label'); if (pl) parts.push(pl.textContent);
    let p = el.previousElementSibling; if (p) parts.push(p.textContent);
    const td = el.closest('td,th'); if (td && td.previousElementSibling) parts.push(td.previousElementSibling.textContent);
    const prevText = el.parentElement && el.parentElement.previousElementSibling; if (prevText) parts.push(prevText.textContent);
    return parts.filter(Boolean).join(' ').replace(/[\s：:*]/g, '').toLowerCase();
  }
  function scopeOf(pw) { return pw.form || pw.closest('form, [role=form], table, .login, #login') || document.body; }
  // 帳號欄位 = 密碼欄位前面最近的文字輸入框
  function userFieldFor(pw) {
    const all = [...scopeOf(pw).querySelectorAll('input')].filter(textLike);
    const before = all.filter(el => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    const named = before.filter(el => /user|login|email|account|帳號|账号|使用者|mail|id/i.test(labelText(el) + (el.autocomplete || '')));
    return named[named.length - 1] || before[before.length - 1] || null;
  }
  function setValue(el, v) {
    const proto = Object.getPrototypeOf(el), desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    el.focus();
    desc.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function fill(id, manual, anchor) {
    const r = await ask({ type: 'get', id, manual: !!manual, url: location.href });
    if (!r || !r.ok) return toast(r && r.err === 'LOCKED' ? '帳號密碼紀錄已上鎖，請先解鎖' : '無法取得帳號密碼');
    const pw = (anchor && anchor.type === 'password' ? anchor : null) || pwFields()[0];
    if (!pw) return toast('這個頁面找不到密碼欄位');
    const scope = scopeOf(pw);
    // 自訂欄位：依欄位名稱對到網頁上同名的輸入框（例如「門市」）
    for (const f of r.fields || []) {
      const key = f.n.replace(/[\s：:]/g, '').toLowerCase();
      const el = [...scope.querySelectorAll('input')].filter(textLike).find(x => x !== pw && labelText(x).includes(key));
      if (el) setValue(el, f.v);
    }
    const u = userFieldFor(pw);
    if (u && r.username) setValue(u, r.username);
    setValue(pw, r.password);
    hideMenu();
  }

  /* ---------- 介面（Shadow DOM） ---------- */
  const host = document.createElement('pv-host');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    *{box-sizing:border-box;font-family:"Microsoft JhengHei UI","Segoe UI",system-ui,sans-serif}
    .menu{position:fixed;width:300px;background:#fff;color:#0f172a;border:1px solid #dde3ec;border-radius:12px;box-shadow:0 14px 40px rgba(15,23,42,.22);overflow:hidden;font-size:13.5px}
    .hd{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#0b1324;color:#fff;font-weight:700;font-size:12.5px}
    .hd b{background:linear-gradient(#ffd27a,#f4b740);color:#1a1300;border-radius:4px;padding:0 5px;font-size:10px}
    .it{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;border-top:1px solid #eef1f6}
    .it:hover,.it.on{background:#eaf0ff}.av{width:28px;height:28px;border-radius:7px;background:#2f5bea;color:#fff;display:grid;place-items:center;font-weight:700;flex:none}
    .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.s{color:#64748b;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .m{min-width:0;flex:1}.msg{padding:12px;color:#475569;line-height:1.5}.btn{display:inline-block;margin-top:8px;background:#2f5bea;color:#fff;border-radius:7px;padding:5px 12px;cursor:pointer;font-weight:600}
    .bar{position:fixed;top:14px;right:14px;width:340px;background:#fff;color:#0f172a;border:1px solid #dde3ec;border-radius:14px;box-shadow:0 18px 50px rgba(15,23,42,.28);padding:14px 16px;font-size:13.5px}
    .bar h4{margin:0 0 4px;font-size:14.5px}.bar .row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
    .bar button{border:1px solid #dde3ec;background:#fff;border-radius:8px;padding:6px 14px;cursor:pointer;font:inherit}
    .bar button.p{background:#2f5bea;border-color:#2f5bea;color:#fff}
    .toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;border-radius:10px;padding:9px 16px;font-size:13px}
    .key{position:fixed;width:22px;height:22px;border-radius:6px;background:#2f5bea;display:grid;place-items:center;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.2)}
    .key svg{width:14px;height:14px;stroke:#fff;fill:none;stroke-width:2.2;stroke-linecap:round}
  </style><div id="ui"></div>`;
  const ui = root.getElementById('ui');
  (document.body || document.documentElement).appendChild(host);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let toastT;
  function toast(t) { let el = root.querySelector('.toast'); if (!el) { el = document.createElement('div'); el.className = 'toast'; ui.appendChild(el); } el.textContent = t; clearTimeout(toastT); toastT = setTimeout(() => el.remove(), 2600); }

  // 密碼／帳號欄位右側的小鑰匙
  const keys = new Map();
  const KEY_SVG = '<svg viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/></svg>';
  function placeKeys() {
    const want = new Set();
    for (const pw of pwFields()) { want.add(pw); const u = userFieldFor(pw); if (u) want.add(u); }
    for (const [el, k] of keys) if (!want.has(el) || !el.isConnected) { k.remove(); keys.delete(el); }
    for (const el of want) {
      let k = keys.get(el);
      if (!k) { k = document.createElement('div'); k.className = 'key'; k.innerHTML = KEY_SVG; k.title = '帳號密碼紀錄 PRO'; k.onmousedown = ev => { ev.preventDefault(); openMenu(el); }; ui.appendChild(k); keys.set(el, k); }
      const r = el.getBoundingClientRect();
      k.style.left = (r.right - 27) + 'px'; k.style.top = (r.top + (r.height - 22) / 2) + 'px';
      k.style.display = r.width > 60 && r.bottom > 0 && r.top < innerHeight ? 'grid' : 'none';
    }
  }

  let menuFor = null;
  function hideMenu() { const m = root.querySelector('.menu'); if (m) m.remove(); menuFor = null; }
  async function openMenu(el) {
    hideMenu(); menuFor = el;
    const m = document.createElement('div'); m.className = 'menu';
    const r = el.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(r.left, innerWidth - 310)) + 'px'; m.style.top = Math.min(r.bottom + 6, innerHeight - 120) + 'px';
    m.innerHTML = '<div class="hd">帳號密碼紀錄 <b>PRO</b></div><div class="msg">讀取中…</div>';
    ui.appendChild(m);
    const res = await ask({ type: 'search', url: location.href });
    if (menuFor !== el) return;
    const body = m.querySelector('.msg');
    const pw = el.type === 'password' ? el : pwFields()[0];
    const newPw = pw && (/new-password/.test(pw.autocomplete) || pwFields().length >= 2);
    if (!res || !res.ok) {
      const err = res && res.err;
      body.innerHTML = err === 'NO_APP' ? '找不到桌面版，請先開啟「帳號密碼紀錄」。'
        : err === 'NOT_PAIRED' ? '尚未配對：請點瀏覽器右上角的擴充功能圖示，按「與桌面版配對」。'
          : err === 'LOCKED' ? `「${esc(res.vault)}」已上鎖。<br><span class="btn" data-a="show">開啟並解鎖</span>`
            : '無法連線：' + esc(err || '');
    } else {
      const gen = newPw ? '<div class="it" data-a="gen"><div class="av">＊</div><div class="m"><div class="t">產生強密碼並填入</div><div class="s">新密碼會在登入後詢問是否儲存</div></div></div>' : '';
      body.outerHTML = (res.items.length ? res.items.map(it => `<div class="it" data-id="${esc(it.id)}"><div class="av">${esc((it.title || '?').trim()[0] || '?')}</div>
        <div class="m"><div class="t">${esc(it.title)}</div><div class="s">${esc(it.username || '（無帳號）')}</div></div></div>`).join('')
        : '<div class="msg">這個網站還沒有存任何帳號。登入後會詢問是否儲存。</div>') + gen;
    }
    m.onmousedown = async ev => {
      ev.preventDefault();
      const it = ev.target.closest('[data-id]'), a = ev.target.closest('[data-a]');
      if (it) fill(it.dataset.id, false, el);
      else if (a && a.dataset.a === 'show') { ask({ type: 'show' }); hideMenu(); }
      else if (a && a.dataset.a === 'gen') {
        const g = await ask({ type: 'generate' });
        if (g && g.ok) { for (const p of pwFields()) setValue(p, g.password); toast('已填入強密碼，登入後記得儲存'); }
        hideMenu();
      }
    };
  }
  document.addEventListener('mousedown', ev => { if (menuFor && ev.target !== host && ev.target !== menuFor) hideMenu(); }, true);
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') hideMenu(); }, true);

  // 工具列彈出視窗要求填入某一筆（使用者手動選的，可以跨網站）
  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg.type === 'fill' && pwFields().length) { fill(msg.id, true).then(() => send({ ok: true })); return true; }
  });

  /* ---------- 登入後詢問是否儲存 ---------- */
  let lastCap = '';
  function capture(scope) {
    const pw = (scope ? [...scope.querySelectorAll('input[type=password]')] : pwFields()).find(p => p.value);
    if (!pw) return;
    const u = userFieldFor(pw), payload = { username: u ? u.value.trim() : '', password: pw.value, title: document.title || location.hostname };
    const sig = payload.username + '\n' + payload.password;
    if (sig === lastCap) return;
    lastCap = sig;
    ask(Object.assign({ type: 'captured' }, payload)).then(r => { if (r && r.ok && r.state !== 'same') showSaveBar(); });
  }
  document.addEventListener('submit', ev => capture(ev.target), true);
  document.addEventListener('click', ev => {
    const b = ev.target.closest('button, input[type=submit], input[type=button], a, [role=button]');
    if (b && /登入|登录|login|log in|sign in|signin|送出|確定|submit|continue|下一步/i.test((b.textContent || '') + ' ' + (b.value || '') + ' ' + (b.id || ''))) capture(null);
  }, true);
  document.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target && ev.target.type === 'password') capture(null); }, true);

  async function showSaveBar() {
    const p = await ask({ type: 'pending' });
    if (!p || root.querySelector('.bar')) return;
    const bar = document.createElement('div'); bar.className = 'bar';
    bar.innerHTML = `<h4>${p.state === 'update' ? '更新密碼？' : '儲存到帳號密碼紀錄？'}</h4>
      <div style="color:#475569">${esc(location.hostname)}${p.username ? '　·　' + esc(p.username) : ''}${p.state === 'update' ? `<br>會更新「${esc(p.name)}」的密碼` : ''}</div>
      <div class="row"><button data-a="no">不要</button><button class="p" data-a="yes">${p.state === 'update' ? '更新' : '儲存'}</button></div>`;
    ui.appendChild(bar);
    bar.onclick = async ev => {
      const a = ev.target.closest('[data-a]'); if (!a) return;
      if (a.dataset.a === 'yes') { const r = await ask({ type: 'save' }); toast(r && r.ok ? '已儲存到帳號密碼紀錄' : '儲存失敗（App 是否已上鎖？）'); }
      else ask({ type: 'dismiss' });
      bar.remove();
    };
  }

  // 頁面變動（SPA、彈出式登入框）時重新找欄位
  let t = 0;
  const refresh = () => { clearTimeout(t); t = setTimeout(placeKeys, 150); };
  new MutationObserver(refresh).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'style', 'class'] });
  addEventListener('scroll', placeKeys, true); addEventListener('resize', placeKeys);
  placeKeys();
  if (window === top) setTimeout(showSaveBar, 600); // 上一頁登入後跳轉過來時詢問
})();
