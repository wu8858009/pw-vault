/* 背景：唯一會連到桌面版本機橋接（127.0.0.1:47321）的地方；網頁裡的 content script 只能透過這裡要資料 */
const API = 'http://127.0.0.1:47321/v1';

async function token() { return (await chrome.storage.local.get('token')).token || ''; }

async function call(action, data) {
  let r;
  try {
    r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action, token: await token() }, data || {})) });
  } catch (e) { return { ok: false, err: 'NO_APP' }; }
  if (!r.ok) return { ok: false, err: 'HTTP_' + r.status };
  const j = await r.json();
  if (j.err === 'NOT_PAIRED') await chrome.storage.local.remove('token');
  return j;
}

// 配對：先拿到確認碼回給彈出視窗，再在背景等使用者到桌面版按「允許」
async function pair(name, send) {
  const s = await call('pair_start', { name });
  send(s);
  if (!s.ok) return;
  await chrome.storage.session.set({ pairing: { code: s.code, at: Date.now() } });
  const w = await call('pair_wait', { rid: s.rid });
  await chrome.storage.session.remove('pairing');
  if (w.ok && w.token) {
    await chrome.storage.local.set({ token: w.token });
    chrome.action.setBadgeText({ text: '✓' }); chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  }
}

const pkey = tabId => 'save_' + tabId;
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  const tabUrl = sender.tab ? sender.tab.url : msg.url;
  (async () => {
    switch (msg.type) {
      case 'status': {
        const h = await call('hello');
        if (!h.ok) return send(h);
        if (!h.paired) return send({ ok: false, err: 'NOT_PAIRED' });
        const st = await call('status');
        const p = (await chrome.storage.session.get('pairing')).pairing;
        return send(Object.assign(st, { pairing: p && Date.now() - p.at < 90000 ? p.code : '' }));
      }
      case 'pair': return pair(msg.name || 'Chrome', send);
      case 'pairing': return send((await chrome.storage.session.get('pairing')).pairing || null);
      case 'search': return send(await call('search', { url: msg.url || tabUrl, q: msg.q || '' }));
      // 網頁內自動跳出的清單只能取「這個網站」的帳號；使用者從工具列手動選的才可跨網站
      case 'get': return send(await call('get', { id: msg.id, url: msg.url || tabUrl, strict: !!sender.tab && !msg.manual }));
      case 'generate': return send(await call('generate'));
      case 'show': return send(await call('show'));
      case 'captured': {
        // 網頁送出登入表單時：問桌面版這組是新的、要更新、還是已經存過
        const c = await call('check', { url: tabUrl, username: msg.username, password: msg.password });
        if (c.ok && c.state !== 'same' && sender.tab) {
          await chrome.storage.session.set({ [pkey(sender.tab.id)]: { url: tabUrl, title: msg.title, username: msg.username, password: msg.password, state: c.state, name: c.title || '', at: Date.now() } });
        }
        return send(c);
      }
      case 'pending': {
        if (!sender.tab) return send(null);
        const p = (await chrome.storage.session.get(pkey(sender.tab.id)))[pkey(sender.tab.id)];
        return send(p && Date.now() - p.at < 180000 ? { state: p.state, username: p.username, name: p.name, url: p.url } : null);
      }
      case 'save': {
        if (!sender.tab) return send({ ok: false });
        const p = (await chrome.storage.session.get(pkey(sender.tab.id)))[pkey(sender.tab.id)];
        await chrome.storage.session.remove(pkey(sender.tab.id));
        return send(p ? await call('save', { url: p.url, title: p.title, username: p.username, password: p.password }) : { ok: false });
      }
      case 'dismiss': if (sender.tab) await chrome.storage.session.remove(pkey(sender.tab.id)); return send({ ok: true });
    }
    send({ ok: false, err: 'BAD_TYPE' });
  })();
  return true; // 非同步回覆
});
