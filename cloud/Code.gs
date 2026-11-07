/**
 * 帳號密碼紀錄系統 — Google 雲端後端（Apps Script，綁定試算表）
 *
 * 只保存「已加密」的密碼庫（AES-256-GCM 密文），Google 與這支程式都看不到內容。
 * 動作（POST text/plain JSON）：
 *   ping {key}            第一次呼叫時設定同步密碼（之後必須相同）
 *   rev  {key}            取得版本號
 *   load {key}            下載密文
 *   save {key, baseRev, vault}   baseRev 不等於目前版本 → CONFLICT（App 會先合併再重傳）
 * 試算表「密碼庫」放目前版本（切成多格），「歷史」保留最近 30 版。
 */
var CHUNK = 45000;
var KEEP_HISTORY = 30;

function doGet() {
  return out_({ ok: true, app: 'PwVault-cloud', v: 1 });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var req = JSON.parse(e.postData.contents);
    var props = PropertiesService.getScriptProperties();
    var stored = props.getProperty('KEY_HASH');
    if (!stored) {
      if (req.a !== 'ping' || !req.key || String(req.key).length < 6) return out_({ ok: false, err: 'NOT_SETUP' });
      stored = hash_(req.key);
      props.setProperty('KEY_HASH', stored);
    }
    if (hash_(req.key || '') !== stored) {
      Utilities.sleep(1500);
      return out_({ ok: false, err: 'BAD_KEY' });
    }
    var rev = Number(props.getProperty('REV') || 0);
    if (req.a === 'ping' || req.a === 'rev') return out_({ ok: true, rev: rev, has: rev > 0 });
    if (req.a === 'load') return out_({ ok: true, rev: rev, vault: rev > 0 ? read_() : null });
    if (req.a === 'save') {
      if (Number(req.baseRev) !== rev) return out_({ ok: false, err: 'CONFLICT', rev: rev });
      var v = String(req.vault || '');
      var f = JSON.parse(v);
      if (f.app !== 'PwVault' || !f.ct || !f.iv) return out_({ ok: false, err: 'NOT_VAULT' });
      write_(v, rev + 1);
      props.setProperty('REV', String(rev + 1));
      return out_({ ok: true, rev: rev + 1 });
    }
    return out_({ ok: false, err: 'BAD_ACTION' });
  } catch (err) {
    return out_({ ok: false, err: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function hash_(s) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'PwVault-key:' + s, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(b);
}

function sheet_(name, header) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (header) sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  }
  return sh;
}

function chunks_(v) {
  var c = [];
  for (var i = 0; i < v.length; i += CHUNK) c.push(v.substring(i, i + CHUNK));
  return c;
}

function read_() {
  var sh = sheet_('密碼庫');
  var n = sh.getLastRow();
  if (n < 2) return null;
  return sh.getRange(2, 1, n - 1, 1).getValues().map(function (r) { return r[0]; }).join('');
}

function write_(v, rev) {
  var c = chunks_(v);
  var sh = sheet_('密碼庫', ['加密資料（請勿編輯）']);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).clearContent();
  var rng = sh.getRange(2, 1, c.length, 1);
  rng.setNumberFormat('@');
  rng.setValues(c.map(function (x) { return [x]; }));

  var hs = sheet_('歷史', ['時間', '版本', '加密資料（切段）']);
  hs.insertRowAfter(1);
  var row = [new Date(), rev].concat(c);
  var hr = hs.getRange(2, 1, 1, row.length);
  hs.getRange(2, 3, 1, c.length).setNumberFormat('@');
  hr.setValues([row]);
  if (hs.getLastRow() > KEEP_HISTORY + 1) hs.deleteRows(KEEP_HISTORY + 2, hs.getLastRow() - KEEP_HISTORY - 1);
}

/** 在編輯器執行一次以授權（不會改資料） */
function authorize() {
  sheet_('說明').getRange(1, 1, 3, 1).setValues([
    ['帳號密碼紀錄系統 — 雲端資料'],
    ['「密碼庫」與「歷史」裡都是加密後的密文，沒有主密碼無法解開。請勿手動編輯。'],
    ['要還原舊版：把「歷史」某列 C 欄之後的內容依序貼回「密碼庫」A2 起，並在 App 重新同步。']
  ]);
  Logger.log('OK, rev=' + (PropertiesService.getScriptProperties().getProperty('REV') || 0));
}

/** 忘記同步密碼時在編輯器執行：清除同步密碼（資料保留），下一台連線的裝置會設定新的 */
function resetSyncKey() {
  PropertiesService.getScriptProperties().deleteProperty('KEY_HASH');
  Logger.log('同步密碼已清除');
}
