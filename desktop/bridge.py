"""瀏覽器擴充功能 ↔ 桌面版的本機橋接（只聽 127.0.0.1:47321）

* 只接受來自瀏覽器擴充功能（Origin = chrome-extension://…）的請求，一般網頁一律拒絕，
  避免網站偷偷呼叫本機 API。
* 第一次使用要「配對」：桌面版跳出視窗讓使用者按允許，之後擴充功能拿到一組隨機權杖，
  桌面版只存權杖的 SHA-256。
* 密碼庫上鎖時不回傳任何資料；帳密內容由網頁端（已解鎖的 App）提供，這裡只負責轉送。
"""
import hashlib
import http.server
import json
import secrets
import threading
import time

PORT = 47321
MAX_BODY = 64 * 1024


def _ok_origin(origin):
    return origin.startswith("chrome-extension://") or origin.startswith("extension://")


class Bridge:
    def __init__(self, api, call_js, show_window):
        self.api = api                  # Api：用來讀寫 kv（權杖）
        self.call_js = call_js          # 在 App 裡執行 JS 並取回結果
        self.show_window = show_window  # 把視窗叫到前面（配對、解鎖時）
        self.pending = {}               # 配對請求 id → [Event, 結果]
        self.last_pair = 0
        self.ok = False
        self.server = None

    # ----- 權杖 -----
    def _tokens(self):
        return self.api.kv_get("ext_tokens") or {}

    def _valid(self, token):
        return bool(token) and hashlib.sha256(token.encode()).hexdigest() in self._tokens()

    def pair_result(self, rid, ok):
        p = self.pending.get(rid)
        if p:
            p[1] = bool(ok)
            p[0].set()
        return True

    def unpair_all(self):
        self.api.kv_set("ext_tokens", None)
        return True

    # ----- 動作 -----
    def handle(self, req):
        a = req.get("action")
        if a == "hello":
            return {"ok": True, "app": "PwVault", "paired": self._valid(req.get("token"))}
        if a == "pair_start":
            # 第 1 步：App 跳出確認視窗，擴充功能同時顯示同一組數字讓使用者比對
            if time.time() - self.last_pair < 3:
                return {"ok": False, "err": "TOO_FAST"}
            self.last_pair = time.time()
            rid, code = secrets.token_hex(8), f"{secrets.randbelow(1000000):06d}"
            self.pending[rid] = [threading.Event(), False, str(req.get("name") or "瀏覽器")[:40]]
            self.show_window()
            self.call_js(f"window.__pvPairAsk && window.__pvPairAsk({json.dumps(self.pending[rid][2])}, {json.dumps(code)}, {json.dumps(rid)})")
            return {"ok": True, "rid": rid, "code": code}
        if a == "pair_wait":
            # 第 2 步：等使用者在 App 按允許／拒絕（最多 90 秒）
            p = self.pending.get(str(req.get("rid") or ""))
            if not p:
                return {"ok": False, "err": "NO_REQUEST"}
            p[0].wait(90)
            self.pending.pop(req.get("rid"), None)
            if not p[1]:
                return {"ok": False, "err": "DENIED"}
            token = secrets.token_urlsafe(32)
            t = self._tokens()
            t[hashlib.sha256(token.encode()).hexdigest()] = {"name": p[2], "at": int(time.time())}
            self.api.kv_set("ext_tokens", t)
            return {"ok": True, "token": token}
        if not self._valid(req.get("token")):
            return {"ok": False, "err": "NOT_PAIRED"}
        if a == "show":
            self.show_window()
            return {"ok": True}
        payload = {k: v for k, v in req.items() if k != "token"}
        res = self.call_js(f"window.__pvExt ? JSON.stringify(window.__pvExt({json.dumps(payload)})) : null")
        if not res:
            return {"ok": False, "err": "APP_NOT_READY"}
        return json.loads(res)

    # ----- HTTP -----
    def start(self):
        bridge = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _cors(self):
                o = self.headers.get("Origin", "")
                if _ok_origin(o):
                    self.send_header("Access-Control-Allow-Origin", o)
                    self.send_header("Access-Control-Allow-Headers", "Content-Type")
                    self.send_header("Access-Control-Allow-Methods", "POST")

            def do_OPTIONS(self):
                self.send_response(204 if _ok_origin(self.headers.get("Origin", "")) else 403)
                self._cors()
                self.end_headers()

            def do_GET(self):
                self.send_error(404)

            def do_POST(self):
                origin = self.headers.get("Origin", "")
                if not _ok_origin(origin):
                    self.send_error(403)
                    return
                n = int(self.headers.get("Content-Length") or 0)
                if n > MAX_BODY:
                    self.send_error(413)
                    return
                try:
                    req = json.loads(self.rfile.read(n) or b"{}")
                    out = bridge.handle(req)
                except Exception as e:  # noqa: BLE001
                    out = {"ok": False, "err": str(e)}
                body = json.dumps(out, ensure_ascii=False).encode()
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

        try:
            self.server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H)
        except OSError:
            self.ok = False
            return False
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.ok = True
        return True
