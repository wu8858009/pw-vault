/**
 * 帳號密碼紀錄系統 — Google 雲端後端（Apps Script，綁定試算表）
 *
 * 只保存「已加密」的密碼庫與附件（AES-256-GCM 密文），Google 與這支程式都看不到內容。
 * 動作（POST text/plain JSON，可帶 ns = 保管庫命名空間；不帶 = 預設保管庫）：
 *   ping {key}                   第一次呼叫時設定該保管庫的同步密碼（之後必須相同）
 *   rev  {key}                   取得版本號
 *   load {key}                   下載密文
 *   save {key, baseRev, vault}   baseRev 不等於目前版本 → CONFLICT（App 會先合併再重傳）
 *   att_put {key, id, data} / att_get {key, id} / att_del {key, id}   加密附件
 * 每個保管庫有自己的同步密碼，所以共用保管庫只需分享那一個保管庫的同步密碼。
 * 試算表「密碼庫[_ns]」放目前版本（切成多格），「歷史[_ns]」保留最近 30 版，「附件[_ns]」一列一個附件。
 */
var CHUNK = 45000;
var KEEP_HISTORY = 30;
var MAX_ATT = 12 * 1024 * 1024;

function doGet() {
  return out_({ ok: true, app: 'PwVault-cloud', v: 2 });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var req = JSON.parse(e.postData.contents);
    var ns = req.ns ? String(req.ns) : '';
    if (ns && !/^[a-z0-9]{4,24}$/.test(ns)) return out_({ ok: false, err: 'BAD_NS' });
    var sfx = ns ? '_' + ns : '';
    var props = PropertiesService.getScriptProperties();
    var stored = props.getProperty('KEY_HASH' + sfx);
    if (!stored) {
      if (req.a !== 'ping' || !req.key || String(req.key).length < 6) return out_({ ok: false, err: 'NOT_SETUP' });
      stored = hash_(req.key);
      props.setProperty('KEY_HASH' + sfx, stored);
    }
    if (hash_(req.key || '') !== stored) {
      Utilities.sleep(1500);
      return out_({ ok: false, err: 'BAD_KEY' });
    }
    var rev = Number(props.getProperty('REV' + sfx) || 0);
    if (req.a === 'ping' || req.a === 'rev') return out_({ ok: true, rev: rev, has: rev > 0 });
    if (req.a === 'load') return out_({ ok: true, rev: rev, vault: rev > 0 ? read_(sfx) : null });
    if (req.a === 'save') {
      if (Number(req.baseRev) !== rev) return out_({ ok: false, err: 'CONFLICT', rev: rev });
      var v = String(req.vault || '');
      var f = JSON.parse(v);
      if (f.app !== 'PwVault' || !f.ct || !f.iv) return out_({ ok: false, err: 'NOT_VAULT' });
      write_(sfx, v, rev + 1);
      props.setProperty('REV' + sfx, String(rev + 1));
      return out_({ ok: true, rev: rev + 1 });
    }
    if (req.a === 'backup_info') return out_(backupInfo_());
    if (req.a === 'backup_now') return out_({ ok: true, files: backupNow_(), info: backupInfo_() });
    if (req.a === 'att_put') return out_(attPut_(sfx, String(req.id || ''), String(req.data || '')));
    if (req.a === 'att_get') return out_(attGet_(sfx, String(req.id || '')));
    if (req.a === 'att_del') return out_(attDel_(sfx, String(req.id || '')));
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

function read_(sfx) {
  var sh = sheet_('密碼庫' + sfx);
  var n = sh.getLastRow();
  if (n < 2) return null;
  return sh.getRange(2, 1, n - 1, 1).getValues().map(function (r) { return r[0]; }).join('');
}

function write_(sfx, v, rev) {
  var c = chunks_(v);
  var sh = sheet_('密碼庫' + sfx, ['加密資料（請勿編輯）']);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).clearContent();
  var rng = sh.getRange(2, 1, c.length, 1);
  rng.setNumberFormat('@');
  rng.setValues(c.map(function (x) { return [x]; }));

  var hs = sheet_('歷史' + sfx, ['時間', '版本', '加密資料（切段）']);
  hs.insertRowAfter(1);
  var row = [new Date(), rev].concat(c);
  if (hs.getMaxColumns() < row.length) hs.insertColumnsAfter(hs.getMaxColumns(), row.length - hs.getMaxColumns());
  hs.getRange(2, 3, 1, c.length).setNumberFormat('@');
  hs.getRange(2, 1, 1, row.length).setValues([row]);
  if (hs.getLastRow() > KEEP_HISTORY + 1) hs.deleteRows(KEEP_HISTORY + 2, hs.getLastRow() - KEEP_HISTORY - 1);
}

/* ---------- 附件：一列 = [id, 大小, 時間, 密文切段…] ---------- */
function attRow_(sh, id) {
  var n = sh.getLastRow();
  if (n < 2) return 0;
  var ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return 0;
}

function attPut_(sfx, id, data) {
  if (!/^[\w-]{6,40}$/.test(id)) return { ok: false, err: 'BAD_ID' };
  if (data.length > MAX_ATT * 1.4) return { ok: false, err: 'TOO_LARGE' };
  var sh = sheet_('附件' + sfx, ['附件 id', '大小', '時間', '加密資料（切段）']);
  var c = chunks_(data);
  var r = attRow_(sh, id);
  if (!r) { r = Math.max(sh.getLastRow(), 1) + 1; }
  else sh.getRange(r, 1, 1, sh.getLastColumn()).clearContent();
  var row = [id, data.length, new Date()].concat(c);
  if (sh.getMaxColumns() < row.length) sh.insertColumnsAfter(sh.getMaxColumns(), row.length - sh.getMaxColumns());
  sh.getRange(r, 4, 1, c.length).setNumberFormat('@');
  sh.getRange(r, 1, 1, row.length).setValues([row]);
  return { ok: true };
}

function attGet_(sfx, id) {
  var sh = sheet_('附件' + sfx, ['附件 id', '大小', '時間', '加密資料（切段）']);
  var r = attRow_(sh, id);
  if (!r) return { ok: false, err: 'NO_ATT' };
  var vals = sh.getRange(r, 4, 1, Math.max(sh.getLastColumn() - 3, 1)).getValues()[0];
  return { ok: true, data: vals.join('') };
}

function attDel_(sfx, id) {
  var sh = sheet_('附件' + sfx, ['附件 id', '大小', '時間', '加密資料（切段）']);
  var r = attRow_(sh, id);
  if (r) sh.deleteRow(r);
  return { ok: true };
}

/* ---------- 每週自動備份到 Google 雲端硬碟（.pwvault，一樣是密文） ---------- */
var KEEP_BACKUPS = 12;

function backupFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('BACKUP_FOLDER');
  if (id) {
    try { if (!Drive.Files.get(id, { fields: 'id,trashed' }).trashed) return id; } catch (e) { }
  }
  var f = Drive.Files.create({ name: '帳號密碼紀錄備份', mimeType: 'application/vnd.google-apps.folder' });
  props.setProperty('BACKUP_FOLDER', f.id);
  return f.id;
}

function namespaces_() {
  var props = PropertiesService.getScriptProperties(), out = [];
  props.getKeys().forEach(function (k) {
    if (k === 'REV' && Number(props.getProperty(k)) > 0) out.push('');
    else if (k.indexOf('REV_') === 0 && Number(props.getProperty(k)) > 0) out.push(k.slice(4));
  });
  return out;
}

function backupNow_() {
  var folder = backupFolder_(), made = [];
  var stamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmm');
  namespaces_().forEach(function (ns) {
    var v = read_(ns ? '_' + ns : '');
    if (!v) return;
    var tag = ns || '個人', name = '帳號密碼備份-' + tag + '-' + stamp + '.pwvault';
    Drive.Files.create({ name: name, parents: [folder], mimeType: 'application/octet-stream' },
      Utilities.newBlob(v, 'application/octet-stream', name));
    made.push(name);
    // 每個保管庫只留最近 12 份
    var list = Drive.Files.list({ q: "'" + folder + "' in parents and trashed=false and name contains '-" + tag + "-'",
      orderBy: 'createdTime desc', fields: 'files(id,name)', pageSize: 100 }).files || [];
    list.slice(KEEP_BACKUPS).forEach(function (f) { Drive.Files.remove(f.id); });
  });
  PropertiesService.getScriptProperties().setProperty('LAST_BACKUP', new Date().toISOString());
  return made;
}

function backupInfo_() {
  var props = PropertiesService.getScriptProperties();
  var scheduled = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'weeklyBackup'; });
  var folder = props.getProperty('BACKUP_FOLDER');
  return { ok: true, scheduled: scheduled, last: props.getProperty('LAST_BACKUP') || '',
    folderUrl: folder ? 'https://drive.google.com/drive/folders/' + folder : '' };
}

/** 每週日凌晨 3 點由觸發條件呼叫 */
function weeklyBackup() {
  backupNow_();
}

/** 在編輯器執行一次：授權雲端硬碟、建立每週備份排程，並馬上備份一次 */
function setupBackup() {
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'weeklyBackup'; })) {
    ScriptApp.newTrigger('weeklyBackup').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();
  }
  Logger.log('已備份：' + backupNow_().join(', '));
  Logger.log(JSON.stringify(backupInfo_()));
}

/** 在編輯器執行一次以授權（不會改資料） */
function authorize() {
  sheet_('說明').getRange(1, 1, 3, 1).setValues([
    ['帳號密碼紀錄系統 — 雲端資料'],
    ['「密碼庫」「歷史」「附件」裡都是加密後的密文，沒有主密碼無法解開。請勿手動編輯。'],
    ['要還原舊版：把「歷史」某列 C 欄之後的內容依序貼回「密碼庫」A2 起，並在 App 重新同步。']
  ]);
  Logger.log('OK, rev=' + (PropertiesService.getScriptProperties().getProperty('REV') || 0));
}

/** 忘記同步密碼時在編輯器執行：清除所有保管庫的同步密碼（資料保留），下一台連線的裝置會設定新的 */
function resetSyncKey() {
  var props = PropertiesService.getScriptProperties();
  props.getKeys().forEach(function (k) { if (k.indexOf('KEY_HASH') === 0) props.deleteProperty(k); });
  Logger.log('同步密碼已清除');
}
