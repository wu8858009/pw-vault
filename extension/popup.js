/* 工具列彈出視窗：配對、目前網站的帳號清單、搜尋、填入、複製、產生密碼 */
const $ = s => document.querySelector(s);
const main = $('#main');
const ask = msg => new Promise(res => chrome.runtime.sendMessage(msg, r => res(chrome.runtime.lastError ? { ok: false, err: 'NO_EXT' } : r)));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let tab = null;

async function copy(text, label) {
  await navigator.clipboard.writeText(text);
  flash(`已複製${label}，20 秒後清除`);
  setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 20000);
}
function flash(t) { const f = $('#flash'); if (f) { f.textContent = t; setTimeout(() => { if (f.isConnected) f.textContent = ''; }, 2500); } }

async function render() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const st = await ask({ type: 'status' });
  if (!st || !st.ok) {
    const err = st && st.err;
    if (err === 'NO_APP') main.innerHTML = '<div class="msg">找不到桌面版。<br>請先開啟電腦上的「帳號密碼紀錄」（可在設定中開啟「開機自動啟動」）。</div>';
    else if (err === 'NOT_PAIRED') {
      const p = await ask({ type: 'pairing' });
      main.innerHTML = p && Date.now() - p.at < 90000 ? pairingView(p.code)
        : '<div class="msg">第一次使用要和桌面版配對，之後就能在網頁上自動填入。<div class="foot"><button class="p" id="pair">與桌面版配對</button></div></div>';
      const b = $('#pair'); if (b) b.onclick = async () => {
        const r = await ask({ type: 'pair', name: navigator.userAgent.includes('Edg/') ? 'Microsoft Edge' : 'Google Chrome' });
        main.innerHTML = r && r.ok ? pairingView(r.code) : `<div class="msg">無法配對：${esc(r && r.err)}</div>`;
      };
    } else if (err === 'LOCKED') {
      $('#vault').textContent = st.vault || '';
      main.innerHTML = '<div class="msg">密碼庫已上鎖。<div class="foot"><button class="p" id="show">開啟桌面版解鎖</button></div></div>';
      $('#show').onclick = () => { ask({ type: 'show' }); window.close(); };
    } else main.innerHTML = `<div class="msg">無法連線：${esc(err)}</div>`;
    return;
  }
  $('#vault').textContent = st.vault;
  let host = '';
  try { host = new URL(tab.url).hostname; } catch (e) { }
  main.innerHTML = `<input id="q" placeholder="搜尋所有帳號…" autocomplete="off">
    <div class="lbl" id="lbl">${host ? '這個網站（' + esc(host) + '）' : '搜尋結果'}</div><div class="list" id="list"></div>
    <div class="foot"><button id="gen">產生強密碼並複製</button><button id="open">開啟桌面版</button></div><div class="lbl" id="flash" style="text-align:center"></div>`;
  $('#gen').onclick = async () => { const g = await ask({ type: 'generate' }); if (g && g.ok) copy(g.password, '新密碼'); };
  $('#open').onclick = () => { ask({ type: 'show' }); window.close(); };
  let qT;
  $('#q').oninput = e => { clearTimeout(qT); qT = setTimeout(() => list(e.target.value.trim()), 180); };
  $('#q').focus();
  list('');
}
function pairingView(code) {
  return `<div class="msg">請到桌面版確認配對，畫面上應顯示同一組數字：<div class="code">${esc(code)}</div>按「允許」後重新開啟這個視窗即可使用。</div>`;
}
async function list(q) {
  const url = q ? '' : (tab && tab.url) || '';
  const r = await ask({ type: 'search', url, q });
  $('#lbl').textContent = q ? `搜尋「${q}」` : $('#lbl').textContent;
  const box = $('#list');
  if (!r || !r.ok) { box.innerHTML = `<div class="empty">${esc(r && r.err)}</div>`; return; }
  if (!r.items.length) { box.innerHTML = `<div class="empty">${q ? '找不到符合的帳號' : '這個網站還沒有存任何帳號'}</div>`; return; }
  box.innerHTML = r.items.map(it => `<div class="it" data-id="${esc(it.id)}"><div class="av">${esc((it.title || '?').trim()[0] || '?')}</div>
    <div class="m"><div class="t">${esc(it.title)}</div><div class="s">${esc(it.username || '（無帳號）')}</div></div>
    <div class="ops"><button class="sm p" data-a="fill">填入</button><button class="sm" data-a="user">帳號</button><button class="sm" data-a="pw">密碼</button></div></div>`).join('');
  box.onclick = async ev => {
    const b = ev.target.closest('[data-a]'); if (!b) return;
    const id = b.closest('[data-id]').dataset.id;
    if (b.dataset.a === 'fill') {
      chrome.tabs.sendMessage(tab.id, { type: 'fill', id }, () => { if (chrome.runtime.lastError) flash('這個頁面不能自動填入，請改用複製'); else window.close(); });
      return;
    }
    const c = await ask({ type: 'get', id, manual: true, url: tab && tab.url });
    if (!c || !c.ok) return flash('無法取得');
    if (b.dataset.a === 'user') copy(c.username, '帳號'); else copy(c.password, '密碼');
  };
}
render();
