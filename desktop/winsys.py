"""Windows 專用功能：全域快速鍵、自動輸入（SendInput）、DPAPI、Windows Hello。"""
import asyncio
import base64
import ctypes
import ctypes.wintypes as wt
import threading
import time

u32 = ctypes.WinDLL("user32", use_last_error=True)
crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
k32 = ctypes.WinDLL("kernel32", use_last_error=True)

u32.GetForegroundWindow.restype = wt.HWND
u32.SetForegroundWindow.argtypes = [wt.HWND]
u32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
u32.IsWindow.argtypes = [wt.HWND]
u32.IsIconic.argtypes = [wt.HWND]
u32.FindWindowW.argtypes = [wt.LPCWSTR, wt.LPCWSTR]
u32.FindWindowW.restype = wt.HWND
u32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
u32.RegisterHotKey.argtypes = [wt.HWND, ctypes.c_int, wt.UINT, wt.UINT]
u32.GetMessageW.argtypes = [ctypes.POINTER(wt.MSG), wt.HWND, wt.UINT, wt.UINT]

SW_MINIMIZE, SW_RESTORE = 6, 9
MOD_ALT, MOD_CONTROL, MOD_NOREPEAT = 0x1, 0x2, 0x4000
WM_HOTKEY = 0x0312


# ---------------- 自動輸入 ----------------
class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD), ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("u", _INPUTUNION)]


u32.SendInput.argtypes = [wt.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
INPUT_KEYBOARD, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE = 1, 0x2, 0x4
VK = {"tab": 0x09, "enter": 0x0D}


def _send(inputs):
    arr = (INPUT * len(inputs))(*inputs)
    u32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))


def _key(vk=0, scan=0, flags=0):
    return INPUT(INPUT_KEYBOARD, _INPUTUNION(ki=KEYBDINPUT(vk, scan, flags, 0, 0)))


def send_text(text: str):
    units = text.encode("utf-16-le")
    for i in range(0, len(units), 2):
        cu = int.from_bytes(units[i:i + 2], "little")
        _send([_key(0, cu, KEYEVENTF_UNICODE), _key(0, cu, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)])
        time.sleep(0.004)


def send_key(name: str):
    vk = VK[name]
    _send([_key(vk), _key(vk, 0, KEYEVENTF_KEYUP)])
    # 網頁常在換欄位時跑程式（自動完成、查門市…），多等一下再打下一段
    time.sleep(0.15)


def run_sequence(items):
    """items: [{"t": "文字"} | {"k": "tab"/"enter"} | {"w": 秒}]"""
    for it in items:
        if "t" in it:
            send_text(str(it["t"]))
        elif "k" in it and it["k"] in VK:
            send_key(it["k"])
        elif "w" in it:
            time.sleep(min(float(it["w"]), 5))


def own_hwnd(title):
    return u32.FindWindowW(None, title)


def bring_front(hwnd):
    if not hwnd:
        return
    if u32.IsIconic(hwnd):
        u32.ShowWindow(hwnd, SW_RESTORE)
    if u32.SetForegroundWindow(hwnd):
        return
    # 前景鎖不放行時：暫時把輸入佇列接到目前前景視窗的執行緒再切換（不送 Alt，避免進入選單模式）
    fg = u32.GetForegroundWindow()
    a = u32.GetWindowThreadProcessId(fg, None)
    b = k32.GetCurrentThreadId()
    if a and a != b and u32.AttachThreadInput(a, b, True):
        try:
            u32.BringWindowToTop(hwnd)
            u32.SetForegroundWindow(hwnd)
        finally:
            u32.AttachThreadInput(a, b, False)


u32.GetAsyncKeyState.argtypes = [ctypes.c_int]
u32.GetAsyncKeyState.restype = ctypes.c_short


def _lbutton_down():
    return bool(u32.GetAsyncKeyState(0x01) & 0x8000)


def wait_click(own, timeout):
    """等使用者在「別的視窗」按一下滑鼠左鍵（放開後）並回傳那個視窗；逾時回傳 None。"""
    end = time.time() + timeout
    while _lbutton_down() and time.time() < end:
        time.sleep(0.02)
    while time.time() < end:
        if _lbutton_down():
            while _lbutton_down():
                time.sleep(0.02)
            fg = u32.GetForegroundWindow()
            if fg and fg != own:
                return fg
        time.sleep(0.02)
    return None


def autotype(own, target, items, timeout=20, on_done=None):
    """縮小自己 → 切回快速鍵前的視窗；沒有的話等使用者點一下目標欄位 → 打字。
    絕不在「縮小後剛好跑到前面的視窗」盲打，避免打進錯的程式。"""
    if own:
        u32.ShowWindow(own, SW_MINIMIZE)
    if target and u32.IsWindow(target) and target != own:
        time.sleep(0.25)
        bring_front(target)
        time.sleep(0.35)
    else:
        if not wait_click(own, timeout):
            if own:
                bring_front(own)
            if on_done:
                on_done(False)
            return False
        time.sleep(0.3)
    run_sequence(items)
    if on_done:
        on_done(True)
    return True


# ---------------- 全域快速鍵 Ctrl+Alt+P ----------------
class Hotkey:
    def __init__(self, on_press):
        self.on_press = on_press
        self.ok = False
        self.prev = None
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        self.ok = bool(u32.RegisterHotKey(None, 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, ord("P")))
        if not self.ok:
            return
        msg = wt.MSG()
        while u32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message == WM_HOTKEY:
                self.prev = u32.GetForegroundWindow()
                try:
                    self.on_press(self.prev)
                except Exception:
                    pass


# ---------------- 偵測 Windows 鎖定／登出／睡眠 ----------------
LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)


class WNDCLASSW(ctypes.Structure):
    _fields_ = [("style", wt.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
                ("hInstance", wt.HINSTANCE), ("hIcon", wt.HICON), ("hCursor", wt.HANDLE), ("hbrBackground", wt.HBRUSH),
                ("lpszMenuName", wt.LPCWSTR), ("lpszClassName", wt.LPCWSTR)]


u32.DefWindowProcW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
u32.DefWindowProcW.restype = LRESULT
u32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
u32.CreateWindowExW.argtypes = [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                wt.HWND, wt.HMENU, wt.HINSTANCE, wt.LPVOID]
u32.CreateWindowExW.restype = wt.HWND
u32.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
k32.GetModuleHandleW.restype = wt.HMODULE
WM_WTSSESSION_CHANGE, WM_POWERBROADCAST = 0x02B1, 0x0218
WTS_EVENTS = {2: "console_disconnect", 4: "remote_disconnect", 6: "logoff", 7: "lock"}
PBT_APMSUSPEND = 4


class SessionWatcher:
    """用一個看不見的視窗接收 Windows 的鎖定／睡眠通知（不是 message-only，否則收不到睡眠通知）。"""

    def __init__(self, on_event):
        self.on_event = on_event
        self.hwnd = None
        self.ready = threading.Event()
        threading.Thread(target=self._loop, daemon=True).start()
        self.ready.wait(3)

    def _proc(self, hwnd, msg, wp, lp):
        try:
            if msg == WM_WTSSESSION_CHANGE and wp in WTS_EVENTS:
                self.on_event(WTS_EVENTS[wp])
            elif msg == WM_POWERBROADCAST and wp == PBT_APMSUSPEND:
                self.on_event("sleep")
        except Exception:
            pass
        return u32.DefWindowProcW(hwnd, msg, wp, lp)

    def _loop(self):
        self._wndproc = WNDPROC(self._proc)  # 保留參考，避免被回收
        hinst = k32.GetModuleHandleW(None)
        wc = WNDCLASSW(0, self._wndproc, 0, 0, hinst, None, None, None, None, "PwVaultSessionWatcher")
        u32.RegisterClassW(ctypes.byref(wc))
        self.hwnd = u32.CreateWindowExW(0, "PwVaultSessionWatcher", "PwVaultSessionWatcher", 0, 0, 0, 0, 0, None, None, hinst, None)
        try:
            ctypes.WinDLL("wtsapi32").WTSRegisterSessionNotification(self.hwnd, 0)
        except Exception:
            pass
        self.ready.set()
        msg = wt.MSG()
        while u32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            u32.TranslateMessage(ctypes.byref(msg))
            u32.DispatchMessageW(ctypes.byref(msg))

    def simulate(self, wts_event=7):
        """測試用：假裝收到「螢幕已鎖定」"""
        u32.PostMessageW(self.hwnd, WM_WTSSESSION_CHANGE, wts_event, 0)


# ---------------- 開機自動啟動（目前使用者的 Run 機碼） ----------------
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def autostart_get(name):
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return None


def autostart_set(name, command):
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        if command:
            winreg.SetValueEx(k, name, 0, winreg.REG_SZ, command)
        else:
            try:
                winreg.DeleteValue(k, name)
            except OSError:
                pass


# ---------------- DPAPI（綁定目前 Windows 使用者） ----------------
class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


crypt32.CryptProtectData.argtypes = [ctypes.POINTER(DATA_BLOB), wt.LPCWSTR, ctypes.POINTER(DATA_BLOB), ctypes.c_void_p, ctypes.c_void_p, wt.DWORD, ctypes.POINTER(DATA_BLOB)]
crypt32.CryptUnprotectData.argtypes = [ctypes.POINTER(DATA_BLOB), ctypes.c_void_p, ctypes.POINTER(DATA_BLOB), ctypes.c_void_p, ctypes.c_void_p, wt.DWORD, ctypes.POINTER(DATA_BLOB)]
k32.LocalFree.argtypes = [ctypes.c_void_p]
_ENTROPY = b"PwVault-WinHello-v1"


def _blob(b: bytes):
    buf = ctypes.create_string_buffer(b, len(b))
    return DATA_BLOB(len(b), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf


def dpapi_protect(data: bytes) -> str:
    src, _a = _blob(data)
    ent, _b = _blob(_ENTROPY)
    out = DATA_BLOB()
    if not crypt32.CryptProtectData(ctypes.byref(src), "PwVault", ctypes.byref(ent), None, None, 1, ctypes.byref(out)):
        raise OSError("CryptProtectData 失敗")
    try:
        return base64.b64encode(ctypes.string_at(out.pbData, out.cbData)).decode()
    finally:
        k32.LocalFree(out.pbData)


def dpapi_unprotect(b64: str) -> bytes:
    src, _a = _blob(base64.b64decode(b64))
    ent, _b = _blob(_ENTROPY)
    out = DATA_BLOB()
    if not crypt32.CryptUnprotectData(ctypes.byref(src), None, ctypes.byref(ent), None, None, 1, ctypes.byref(out)):
        raise OSError("CryptUnprotectData 失敗")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        k32.LocalFree(out.pbData)


# ---------------- Windows Hello ----------------
HELLO_STATUS = {0: "可用", 1: "這台電腦沒有 Windows Hello 裝置", 2: "尚未設定 Windows Hello（設定 → 帳戶 → 登入選項）",
                3: "Windows Hello 已被原則停用", 4: "Windows Hello 裝置忙碌中", -1: "缺少 Windows Hello 元件"}


def _run_async(coro_factory):
    box = {}

    def worker():
        try:
            box["r"] = asyncio.run(coro_factory())
        except Exception as e:  # noqa: BLE001
            box["e"] = e
    t = threading.Thread(target=worker)
    t.start()
    t.join(120)
    if "e" in box:
        raise box["e"]
    return box.get("r")


def hello_availability() -> int:
    try:
        from winrt.windows.security.credentials.ui import UserConsentVerifier
    except Exception:
        return -1

    async def go():
        return int(await UserConsentVerifier.check_availability_async())
    try:
        return _run_async(go)
    except Exception:
        return -1


def hello_verify(message: str) -> bool:
    from winrt.windows.security.credentials.ui import UserConsentVerifier

    async def go():
        return int(await UserConsentVerifier.request_verification_async(message))
    return _run_async(go) == 0  # 0 = Verified
