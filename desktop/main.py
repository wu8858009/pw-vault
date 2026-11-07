"""帳號密碼紀錄系統 — Windows 桌面版（pywebview + WebView2）

介面與加密全部在 web/（和 PWA 同一份）；這裡只負責：
  * 把加密後的密碼庫存到 %APPDATA%\\PasswordVault\\vault.json（每天另存一份備份）
  * 剪貼簿：不進 Win+V 剪貼簿歷程 / 雲端同步，並在 N 秒後自動清除
測試：PWVAULT_DATA=<資料夾>（同時略過單一執行個體檢查）、PWVAULT_SELFTEST=<結果.json>
"""
import base64
import ctypes
import ctypes.wintypes as wt
import datetime
import functools
import http.server
import json
import os
import sys
import threading
import urllib.parse
import webbrowser
from pathlib import Path

import re

import webview

import bridge
import winsys

APP_NAME = "帳號密碼紀錄系統"
VERSION = "1.4.0"
BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
WEB = BASE / "web"
DATA_DIR = Path(os.environ.get("PWVAULT_DATA") or Path(os.environ.get("APPDATA", Path.home())) / "PasswordVault")
LOCAL = DATA_DIR / "local.json"      # 裝置設定（保管庫清單、裝置名稱…；不含任何密碼）
HELLO = DATA_DIR / "hello.json"      # Windows Hello：DPAPI 保護的主密碼
SELFTEST = os.environ.get("PWVAULT_SELFTEST")
CLOUDTEST = os.environ.get("PWVAULT_CLOUDTEST")  # 自我測試用的模擬雲端網址
HIBPTEST = os.environ.get("PWVAULT_HIBPTEST")    # 自我測試用的假外洩資料庫
KEEP_BACKUPS = 30

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
u32 = ctypes.WinDLL("user32", use_last_error=True)


# ---------------- 剪貼簿 ----------------
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
k32.GlobalAlloc.argtypes = [wt.UINT, ctypes.c_size_t]
k32.GlobalAlloc.restype = wt.HGLOBAL
k32.GlobalLock.argtypes = [wt.HGLOBAL]
k32.GlobalLock.restype = ctypes.c_void_p
k32.GlobalUnlock.argtypes = [wt.HGLOBAL]
k32.GlobalFree.argtypes = [wt.HGLOBAL]
k32.GlobalFree.restype = wt.HGLOBAL
u32.OpenClipboard.argtypes = [wt.HWND]
u32.SetClipboardData.argtypes = [wt.UINT, wt.HANDLE]
u32.SetClipboardData.restype = wt.HANDLE
u32.GetClipboardData.argtypes = [wt.UINT]
u32.GetClipboardData.restype = wt.HANDLE
u32.RegisterClipboardFormatW.argtypes = [wt.LPCWSTR]
u32.RegisterClipboardFormatW.restype = wt.UINT
u32.IsClipboardFormatAvailable.argtypes = [wt.UINT]


def _open_clip():
    for _ in range(20):
        if u32.OpenClipboard(None):
            return True
        threading.Event().wait(0.05)
    return False


def _hglobal(data: bytes):
    h = k32.GlobalAlloc(GMEM_MOVEABLE, len(data))
    p = k32.GlobalLock(h)
    ctypes.memmove(p, data, len(data))
    k32.GlobalUnlock(h)
    return h


def clip_set(text: str) -> bool:
    if not _open_clip():
        return False
    try:
        u32.EmptyClipboard()
        if text:
            u32.SetClipboardData(CF_UNICODETEXT, _hglobal((text + "\0").encode("utf-16-le")))
            zero = (0).to_bytes(4, "little")
            # 不進剪貼簿歷程（Win+V）、不同步到雲端、剪貼簿監看程式略過
            for fmt, val in (("CanIncludeInClipboardHistory", zero), ("CanUploadToCloudClipboard", zero),
                             ("ExcludeClipboardContentFromMonitorProcessing", zero)):
                u32.SetClipboardData(u32.RegisterClipboardFormatW(fmt), _hglobal(val))
        return True
    finally:
        u32.CloseClipboard()


def clip_get() -> str:
    if not u32.IsClipboardFormatAvailable(CF_UNICODETEXT) or not _open_clip():
        return ""
    try:
        h = u32.GetClipboardData(CF_UNICODETEXT)
        if not h:
            return ""
        p = k32.GlobalLock(h)
        try:
            return ctypes.wstring_at(p)
        finally:
            k32.GlobalUnlock(h)
    finally:
        u32.CloseClipboard()


class Clipboard:
    def __init__(self):
        self.mine = None
        self.timer = None
        self.lock = threading.Lock()

    def copy(self, text: str, seconds: int):
        with self.lock:
            if self.timer:
                self.timer.cancel()
            ok = clip_set(text)
            self.mine = text
            if ok and seconds and seconds > 0:
                self.timer = threading.Timer(seconds, self.clear_if_mine)
                self.timer.daemon = True
                self.timer.start()
            return ok

    def clear_if_mine(self):
        with self.lock:
            if self.mine is not None and clip_get() == self.mine:
                clip_set("")
            self.mine = None


CLIP = Clipboard()


# ---------------- 檔案 ----------------
_WRITE_LOCK = threading.Lock()


def write_atomic(path: Path, text: str):
    # pywebview 會在不同執行緒同時呼叫 API，所以寫檔要排隊，暫存檔名也要各自不同
    with _WRITE_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f"{path.suffix}.{threading.get_ident()}.tmp")
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        for i in range(10):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if i == 9:
                    raise
                threading.Event().wait(0.05)


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def vdir(vid) -> Path:
    """預設保管庫沿用舊路徑；其他保管庫在 vaults/<id>/"""
    if not vid or vid == "default":
        return DATA_DIR
    if not re.fullmatch(r"[a-z0-9]{4,24}", str(vid)):
        raise ValueError("bad vault id")
    return DATA_DIR / "vaults" / vid


def daily_backup(d: Path, text: str):
    b = d / "backups"
    write_atomic(b / f"vault-{datetime.date.today():%Y%m%d}.json", text)
    for p in sorted(b.glob("vault-*.json"))[:-KEEP_BACKUPS]:
        p.unlink(missing_ok=True)


def looks_like_vault(text: str) -> bool:
    try:
        f = json.loads(text)
        return f.get("app") == "PwVault" and bool(f.get("ct")) and bool(f.get("iv"))
    except Exception:
        return False


def att_path(vid, aid) -> Path:
    if not re.fullmatch(r"[\w-]{6,40}", str(aid)):
        raise ValueError("bad attachment id")
    return vdir(vid) / "attachments" / f"{aid}.bin"


class Api:
    def __init__(self):
        self._window = None
        self._hotkey = None
        self._tray = None
        self._watcher = None
        self._bridge = None
        self._quitting = False
        self._kv_lock = threading.Lock()

    # ----- 密碼庫（每個保管庫一個資料夾） -----
    def load_vault(self, vid=None):
        v = vdir(vid) / "vault.json"
        try:
            return v.read_text(encoding="utf-8") if v.exists() else None
        except Exception:
            bak = v.with_suffix(".bak")
            return bak.read_text(encoding="utf-8") if bak.exists() else None

    def save_vault(self, text, vid=None):
        # 只接受加密格式，絕不把明文寫進磁碟
        if not looks_like_vault(text):
            return "格式錯誤，未寫入"
        try:
            d = vdir(vid)
            v = d / "vault.json"
            if v.exists():
                write_atomic(v.with_suffix(".bak"), v.read_text(encoding="utf-8"))
            write_atomic(v, text)
            daily_backup(d, text)
            return True
        except Exception as e:
            return str(e)

    def get_cloud(self, vid=None):
        c = vdir(vid) / "cloud.json"
        try:
            return c.read_text(encoding="utf-8") if c.exists() else None
        except Exception:
            return None

    def set_cloud(self, text, vid=None):
        # 雲端網址 + 同步密碼（只保護雲端上的密文；主密碼不會存）
        c = vdir(vid) / "cloud.json"
        if text:
            write_atomic(c, text)
        else:
            c.unlink(missing_ok=True)
        return True

    def delete_vault(self, vid):
        """移除這台電腦上的某個保管庫（不影響雲端）；預設保管庫不能刪"""
        import shutil
        if not vid or vid == "default":
            return "預設保管庫不能移除"
        shutil.rmtree(vdir(vid), ignore_errors=True)
        self.hello_remove(vid)
        return True

    # ----- 裝置設定 -----
    def kv_get(self, key):
        return read_json(LOCAL, {}).get(str(key))

    def kv_set(self, key, value):
        with self._kv_lock:
            d = read_json(LOCAL, {})
            if value is None:
                d.pop(str(key), None)
            else:
                d[str(key)] = value
            write_atomic(LOCAL, json.dumps(d, ensure_ascii=False))
        return True

    # ----- 加密附件（本機快取） -----
    def att_put(self, vid, aid, text):
        write_atomic(att_path(vid, aid), text)
        return True

    def att_get(self, vid, aid):
        p = att_path(vid, aid)
        return p.read_text(encoding="utf-8") if p.exists() else None

    def att_del(self, vid, aid):
        att_path(vid, aid).unlink(missing_ok=True)
        return True

    # ----- 檔案輸出 -----
    def _ask_path(self, name):
        r = self._window.create_file_dialog(webview.SAVE_DIALOG, directory=str(Path.home() / "Documents"), save_filename=name)
        if not r:
            return None
        return r if isinstance(r, str) else r[0]

    def save_file(self, name, text):
        path = self._ask_path(name)
        if path:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(text)
        return path

    def save_bytes(self, name, b64):
        path = self._ask_path(name)
        if path:
            Path(path).write_bytes(base64.b64decode(b64))
        return path

    # ----- 剪貼簿 / 網址 -----
    def copy(self, text, seconds=20):
        return CLIP.copy(str(text), int(seconds or 0))

    def clip_text(self):
        return clip_get()

    def open_url(self, url):
        if isinstance(url, str) and url.lower().startswith(("http://", "https://")):
            webbrowser.open(url)

    # ----- 自動輸入 / 全域快速鍵 -----
    def autotype(self, items, use_prev=True, timeout=20):
        """use_prev：快速鍵叫出時，打回原本的視窗；否則等使用者點一下目標欄位"""
        own = winsys.own_hwnd(APP_NAME)
        target = self._hotkey.prev if (use_prev and self._hotkey) else None
        if self._hotkey:
            self._hotkey.prev = None

        def done(ok):
            if not ok and self._window:
                self._window.evaluate_js("window.__pvAutotypeTimeout && window.__pvAutotypeTimeout()")
        threading.Thread(target=winsys.autotype, args=(own, target, items, timeout, done), daemon=True).start()
        return {"target": bool(target)}

    def hotkey_info(self):
        return {"ok": bool(self._hotkey and self._hotkey.ok), "prev": bool(self._hotkey and self._hotkey.prev)}

    def hide(self):
        own = winsys.own_hwnd(APP_NAME)
        if own:
            winsys.u32.ShowWindow(own, winsys.SW_MINIMIZE)
        return True

    # ----- Windows Hello（主密碼以 DPAPI 保護，解開前必須通過 Windows Hello） -----
    def _hello_probe(self):
        # WinRT 查詢可能很慢，啟動時在背景查一次就好
        self._hello_code = winsys.hello_availability()

    def hello_enrolled(self, vid=None):
        return str(vid or "default") in read_json(HELLO, {})

    def hello_status(self, vid=None):
        code = getattr(self, "_hello_code", None)
        if code is None:
            return {"code": -2, "msg": "正在偵測 Windows Hello，請稍後再開一次設定", "enrolled": self.hello_enrolled(vid)}
        return {"code": code, "msg": winsys.HELLO_STATUS.get(code, str(code)), "enrolled": self.hello_enrolled(vid)}

    def hello_enroll(self, vid, secret):
        try:
            if not winsys.hello_verify("確認是你本人，啟用 Windows Hello 解鎖"):
                return "Windows Hello 驗證未通過"
            d = read_json(HELLO, {})
            d[str(vid or "default")] = winsys.dpapi_protect(str(secret).encode("utf-8"))
            write_atomic(HELLO, json.dumps(d))
            return True
        except Exception as e:
            return f"無法啟用：{e}"

    def hello_unlock(self, vid=None):
        d = read_json(HELLO, {})
        blob = d.get(str(vid or "default"))
        if not blob:
            return {"err": "尚未啟用"}
        try:
            if not winsys.hello_verify("解鎖帳號密碼紀錄"):
                return {"err": "Windows Hello 驗證未通過"}
            return {"pw": winsys.dpapi_unprotect(blob).decode("utf-8")}
        except Exception as e:
            return {"err": str(e)}

    def hello_remove(self, vid=None):
        d = read_json(HELLO, {})
        d.pop(str(vid or "default"), None)
        write_atomic(HELLO, json.dumps(d))
        return True

    # ----- 開機自動啟動 / 系統匣 -----
    def autostart_get(self):
        cur = winsys.autostart_get(APP_NAME)
        return {"on": bool(cur), "frozen": bool(getattr(sys, "frozen", False)), "tray": bool(self._tray)}

    def autostart_set(self, on):
        if not getattr(sys, "frozen", False):
            return "只有安裝版（exe）可以設定開機自動啟動"
        try:
            winsys.autostart_set(APP_NAME, f'"{sys.executable}" --background' if on else None)
            return True
        except Exception as e:
            return str(e)

    # ----- 瀏覽器擴充功能橋接 -----
    def bridge_info(self):
        b = self._bridge
        return {"ok": bool(b and b.ok), "port": bridge.PORT, "paired": len(self.kv_get("ext_tokens") or {})}

    def bridge_pair_result(self, rid, ok):
        return self._bridge.pair_result(rid, ok) if self._bridge else False

    def bridge_unpair(self):
        return self._bridge.unpair_all() if self._bridge else False

    def open_ext_dir(self):
        base = Path(sys.executable).parent if getattr(sys, "frozen", False) else BASE / "extension"
        d = base / "瀏覽器擴充功能" if getattr(sys, "frozen", False) else base
        if d.exists():
            os.startfile(str(d))
            return str(d)
        return None

    def bridge_selftest(self):
        """自我測試用：假裝成擴充功能打本機橋接（配對 → 搜尋 → 取帳密 → 儲存），並確認一般網頁會被擋"""
        import urllib.request

        def post(body, origin="chrome-extension://selftest"):
            req = urllib.request.Request(f"http://127.0.0.1:{bridge.PORT}/v1", data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json", "Origin": origin}, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                return {"http": e.code}
        out = {"web_blocked": post({"action": "hello"}, origin="https://evil.example").get("http") == 403}
        out["unpaired"] = post({"action": "search", "url": "https://x"}).get("err")
        ps = post({"action": "pair_start", "name": "selftest"})
        p = post({"action": "pair_wait", "rid": ps.get("rid")})
        tok = p.get("token")
        out["code"] = len(ps.get("code") or "") == 6
        out["paired"] = bool(tok)
        out["search"] = post({"action": "search", "url": "https://www.bank.example.tw/login", "token": tok})
        hits = (out["search"] or {}).get("items") or []
        out["get"] = post({"action": "get", "id": hits[0]["id"], "token": tok}) if hits else None
        out["save"] = post({"action": "save", "url": "https://new.example.com/login", "username": "ext-user", "password": "Ext-Pass-2026!", "token": tok})
        out["check"] = post({"action": "check", "url": "https://new.example.com/", "username": "ext-user", "password": "Ext-Pass-2026!", "token": tok})
        return out

    def test_os_lock(self):
        """自我測試用：模擬 Windows 鎖定螢幕"""
        if self._watcher:
            self._watcher.simulate(7)
        return bool(self._watcher)

    def info(self):
        return {"data_dir": str(DATA_DIR), "version": VERSION, "hotkey": bool(self._hotkey and self._hotkey.ok), "tray": bool(self._tray)}

    def selftest_done(self, result):
        Path(SELFTEST).write_text(result, encoding="utf-8")
        threading.Timer(0.3, self._window.destroy).start()


# ---------------- 本機網頁伺服器（只提供 web/ 靜態檔） ----------------
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        self.send_error(405)


def serve():
    Quiet.extensions_map[".webmanifest"] = "application/manifest+json"
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(WEB)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def single_instance() -> bool:
    if os.environ.get("PWVAULT_DATA"):
        return True
    k32.CreateMutexW(None, False, "Local\\PwVaultDesktopSingleInstance")
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        hwnd = u32.FindWindowW(None, APP_NAME)
        if hwnd:
            u32.ShowWindow(hwnd, 5)   # 可能藏在系統匣，先顯示
            u32.ShowWindow(hwnd, 3)   # 最大化
            u32.SetForegroundWindow(hwnd)
        return False
    return True


def start_tray(api, win):
    """系統匣圖示：關閉視窗後仍在背景執行，Ctrl+Alt+P 隨時可用"""
    try:
        import pystray
        from PIL import Image
    except Exception:
        return None

    def show(*_):
        win.show()
        win.maximize()
        winsys.bring_front(winsys.own_hwnd(APP_NAME))

    def palette(*_):
        show()
        win.evaluate_js("window.__pvPalette && window.__pvPalette()")

    def lock(*_):
        win.evaluate_js("window.__pvLock && window.__pvLock('已從系統匣上鎖', true)")

    def quit_app(*_):
        api._quitting = True
        icon.stop()
        win.destroy()

    img = Image.open(BASE / "desktop" / "app.ico")
    menu = pystray.Menu(
        pystray.MenuItem("開啟帳號密碼紀錄", show, default=True),
        pystray.MenuItem("快速搜尋（Ctrl+Alt+P）", palette),
        pystray.MenuItem("立即上鎖", lock),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("結束", quit_app))
    icon = pystray.Icon("PwVault", img, APP_NAME, menu)
    icon.run_detached()
    return icon


def main():
    if not single_instance():
        return
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("PwVault.Desktop")
    except Exception:
        pass
    background = "--background" in sys.argv   # 開機自動啟動：只放系統匣，不跳出視窗
    port = serve()
    api = Api()
    url = f"http://127.0.0.1:{port}/index.html?desktop=1" + ("&selftest=1" if SELFTEST else "") \
        + (f"&cloud={urllib.parse.quote(CLOUDTEST, safe='')}" if SELFTEST and CLOUDTEST else "") \
        + (f"&hibp={urllib.parse.quote(HIBPTEST, safe='')}" if SELFTEST and HIBPTEST else "")
    win = webview.create_window(APP_NAME, url, js_api=api, width=1240, height=800, min_size=(760, 540),
                                background_color="#0a0f1c", maximized=True, hidden=background)
    api._window = win

    def on_hotkey(prev):
        own = winsys.own_hwnd(APP_NAME)
        if prev == own:
            api._hotkey.prev = None
        if not u32.IsWindowVisible(own):
            win.show()
            win.maximize()
        winsys.bring_front(own)
        win.evaluate_js("window.__pvPalette && window.__pvPalette()")

    if not SELFTEST:
        api._hotkey = winsys.Hotkey(on_hotkey)
        api._tray = start_tray(api, win)
    threading.Thread(target=api._hello_probe, daemon=True).start()

    # 瀏覽器擴充功能的本機橋接（自我測試時改用別的埠，避免和正在用的 App 衝突）
    def show_window():
        own = winsys.own_hwnd(APP_NAME)
        if not u32.IsWindowVisible(own):
            win.show()
            win.maximize()
        winsys.bring_front(own)
    if os.environ.get("PWVAULT_BRIDGEPORT"):
        bridge.PORT = int(os.environ["PWVAULT_BRIDGEPORT"])
    api._bridge = bridge.Bridge(api, win.evaluate_js, show_window)
    api._bridge.start()

    # Windows 鎖定螢幕、登出、睡眠 → 密碼庫一起上鎖
    reasons = {"lock": "電腦已鎖定，密碼庫一併上鎖", "sleep": "電腦進入睡眠，密碼庫一併上鎖", "logoff": "Windows 登出，密碼庫已上鎖"}
    api._watcher = winsys.SessionWatcher(
        lambda ev: win.evaluate_js(f"window.__pvLock && window.__pvLock({json.dumps(reasons.get(ev, '已上鎖'))})"))

    def on_closing():
        # 有系統匣時，按 X 只是藏起來（可在設定關閉這個行為）
        if api._tray and not api._quitting and api.kv_get("closeToTray") is not False:
            win.hide()
            return False
        CLIP.clear_if_mine()
        if api._tray:
            api._tray.stop()

    win.events.closing += on_closing
    webview.start(private_mode=True, icon=str(BASE / "desktop" / "app.ico") if (BASE / "desktop" / "app.ico").exists() else None)


if __name__ == "__main__":
    main()

