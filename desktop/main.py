"""帳號密碼紀錄系統 — Windows 桌面版（pywebview + WebView2）

介面與加密全部在 web/（和 PWA 同一份）；這裡只負責：
  * 把加密後的密碼庫存到 %APPDATA%\\PasswordVault\\vault.json（每天另存一份備份）
  * 剪貼簿：不進 Win+V 剪貼簿歷程 / 雲端同步，並在 N 秒後自動清除
測試：PWVAULT_DATA=<資料夾>（同時略過單一執行個體檢查）、PWVAULT_SELFTEST=<結果.json>
"""
import ctypes
import ctypes.wintypes as wt
import datetime
import functools
import http.server
import json
import os
import sys
import threading
import webbrowser
from pathlib import Path

import webview

APP_NAME = "帳號密碼紀錄系統"
VERSION = "1.0.0"
BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
WEB = BASE / "web"
DATA_DIR = Path(os.environ.get("PWVAULT_DATA") or Path(os.environ.get("APPDATA", Path.home())) / "PasswordVault")
VAULT = DATA_DIR / "vault.json"
BACKUPS = DATA_DIR / "backups"
SELFTEST = os.environ.get("PWVAULT_SELFTEST")
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
def write_atomic(path: Path, text: str):
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def daily_backup(text: str):
    BACKUPS.mkdir(parents=True, exist_ok=True)
    write_atomic(BACKUPS / f"vault-{datetime.date.today():%Y%m%d}.json", text)
    old = sorted(BACKUPS.glob("vault-*.json"))[:-KEEP_BACKUPS]
    for p in old:
        p.unlink(missing_ok=True)


def looks_like_vault(text: str) -> bool:
    try:
        f = json.loads(text)
        return f.get("app") == "PwVault" and bool(f.get("ct")) and bool(f.get("iv"))
    except Exception:
        return False


class Api:
    def __init__(self):
        self.window = None

    def load_vault(self):
        try:
            return VAULT.read_text(encoding="utf-8") if VAULT.exists() else None
        except Exception:
            bak = VAULT.with_suffix(".bak")
            return bak.read_text(encoding="utf-8") if bak.exists() else None

    def save_vault(self, text):
        # 只接受加密格式，絕不把明文寫進磁碟
        if not looks_like_vault(text):
            return "格式錯誤，未寫入"
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            if VAULT.exists():
                write_atomic(VAULT.with_suffix(".bak"), VAULT.read_text(encoding="utf-8"))
            write_atomic(VAULT, text)
            daily_backup(text)
            return True
        except Exception as e:
            return str(e)

    def save_file(self, name, text):
        r = self.window.create_file_dialog(webview.SAVE_DIALOG, directory=str(Path.home() / "Documents"), save_filename=name)
        if not r:
            return None
        path = r if isinstance(r, str) else r[0]
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        return path

    def copy(self, text, seconds=20):
        return CLIP.copy(str(text), int(seconds or 0))

    def clip_text(self):
        return clip_get()

    def open_url(self, url):
        if isinstance(url, str) and url.lower().startswith(("http://", "https://")):
            webbrowser.open(url)

    def info(self):
        return {"data_dir": str(DATA_DIR), "version": VERSION}

    def selftest_done(self, result):
        Path(SELFTEST).write_text(result, encoding="utf-8")
        threading.Timer(0.3, self.window.destroy).start()


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
            u32.ShowWindow(hwnd, 9)
            u32.SetForegroundWindow(hwnd)
        return False
    return True


def main():
    if not single_instance():
        return
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("PwVault.Desktop")
    except Exception:
        pass
    port = serve()
    api = Api()
    url = f"http://127.0.0.1:{port}/index.html?desktop=1" + ("&selftest=1" if SELFTEST else "")
    win = webview.create_window(APP_NAME, url, js_api=api, width=1180, height=760, min_size=(720, 520),
                                background_color="#12161d")
    api.window = win

    def on_closing():
        CLIP.clear_if_mine()

    win.events.closing += on_closing
    webview.start(private_mode=True, icon=str(BASE / "desktop" / "app.ico") if (BASE / "desktop" / "app.ico").exists() else None)


if __name__ == "__main__":
    main()
