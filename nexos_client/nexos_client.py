"""Nexos.ai 自动化客户端
协议逆向分析结论：
- 注册: POST /api/auth/update-registration  (flow + updateRegistrationFlowBody JSON)
- 验证: POST /api/auth/update-verification  (flow + updateVerificationFlowBody JSON)
- 登录: GET /oryBridge/.ory/self-service/login/browser → POST ui.action (JSON)
- 文件: POST /api/chat/{chatId} action=chat_file_upload
- 对话: POST /api/chat/{chatId} action=chat_completion (SSE)
"""
import os
import json
import time
import re
import uuid
import requests
from dotenv import load_dotenv

load_dotenv()

BASE = "https://workspace.nexos.ai"
ORYBRIDGE = f"{BASE}/oryBridge/.ory"
TURNSTILE_SITEKEY = "0x4AAAAAACZj49I1vZV-qxTZ"


def _extract_csrf(flow: dict) -> str:
    for node in flow.get("ui", {}).get("nodes", []):
        attrs = node.get("attributes", {})
        if attrs.get("name") == "csrf_token":
            return attrs.get("value", "")
    return ""


def solve_turnstile_2captcha(page_url: str, api_key: str) -> str:
    """用 2captcha 解 Cloudflare Turnstile"""
    create_url = "https://2captcha.com/in.php"
    result_url = "https://2captcha.com/res.php"

    resp = requests.post(create_url, data={
        "key": api_key,
        "method": "turnstile",
        "sitekey": TURNSTILE_SITEKEY,
        "pageurl": page_url,
        "json": 1,
    }, timeout=30)
    data = resp.json()
    if data.get("status") != 1:
        raise RuntimeError(f"2captcha submit failed: {data}")

    task_id = data["request"]
    for _ in range(60):
        time.sleep(5)
        r = requests.get(result_url, params={
            "key": api_key, "action": "get", "id": task_id, "json": 1
        }, timeout=15)
        res = r.json()
        if res.get("status") == 1:
            return res["request"]
        if res.get("request") != "CAPCHA_NOT_READY":
            raise RuntimeError(f"2captcha error: {res}")
    raise TimeoutError("2captcha timeout")


def solve_turnstile_capsolver(page_url: str, api_key: str) -> str:
    """用 CapSolver 解 Cloudflare Turnstile"""
    headers = {"Content-Type": "application/json"}

    resp = requests.post("https://api.capsolver.com/createTask", headers=headers, json={
        "clientKey": api_key,
        "task": {
            "type": "AntiTurnstileTaskProxyLess",
            "websiteURL": page_url,
            "websiteKey": TURNSTILE_SITEKEY,
        }
    }, timeout=30)
    data = resp.json()
    if data.get("errorId") != 0:
        raise RuntimeError(f"CapSolver create failed: {data}")

    task_id = data["taskId"]
    for _ in range(60):
        time.sleep(3)
        r = requests.post("https://api.capsolver.com/getTaskResult", headers=headers, json={
            "clientKey": api_key,
            "taskId": task_id,
        }, timeout=15)
        res = r.json()
        if res.get("status") == "ready":
            return res["solution"]["token"]
        if res.get("errorId") != 0:
            raise RuntimeError(f"CapSolver error: {res}")
    raise TimeoutError("CapSolver timeout")


class NexosClient:
    def __init__(self, solver: str = "2captcha"):
        """
        solver: "2captcha" 或 "capsolver"
        对应环境变量: CAPTCHA_API_KEY
        """
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Origin": BASE,
        })
        self.solver = solver
        self.captcha_key = os.getenv("CAPTCHA_API_KEY", "")

    def _solve_turnstile(self, page_url: str) -> str:
        if not self.captcha_key:
            raise ValueError("CAPTCHA_API_KEY 未设置")
        if self.solver == "capsolver":
            return solve_turnstile_capsolver(page_url, self.captcha_key)
        return solve_turnstile_2captcha(page_url, self.captcha_key)

    # ─────────────────────────── 注册流程 ───────────────────────────

    def register(self, email: str, password: str) -> str:
        """注册新账户，返回 verification flow ID"""
        print(f"[+] 获取注册 flow...")
        resp = self.session.get(
            f"{ORYBRIDGE}/self-service/registration/browser",
            headers={"Referer": f"{BASE}/authorization/registration"},
        )
        resp.raise_for_status()
        flow = resp.json()
        flow_id = flow["id"]
        csrf_token = _extract_csrf(flow)
        print(f"[+] flow_id={flow_id}")

        print(f"[+] 解 Turnstile...")
        page_url = f"{BASE}/authorization/registration"
        turnstile_token = self._solve_turnstile(page_url)
        print(f"[+] Turnstile OK")

        # 构造 updateRegistrationFlowBody（transient_payload 双重 JSON 编码）
        body = {
            "csrf_token": csrf_token,
            "traits.email": email,
            "password": password,
            "transient_payload": json.dumps({"turnstile_token": turnstile_token}),
            "method": "password",
        }

        print(f"[+] 提交注册...")
        resp = self.session.post(
            f"{BASE}/api/auth/update-registration",
            headers={"Referer": f"{BASE}/authorization/registration"},
            data={
                "flow": json.dumps(flow_id),
                "updateRegistrationFlowBody": json.dumps(body),
            },
        )

        if resp.status_code not in (200, 201, 422):
            raise RuntimeError(f"注册失败 {resp.status_code}: {resp.text[:300]}")

        result = resp.json()
        print(f"[+] 注册响应: {json.dumps(result, ensure_ascii=False)[:200]}")

        # 从响应中提取 verification flow ID
        verif_flow_id = self._extract_verification_flow(result)
        if not verif_flow_id:
            # 从 redirect_browser_to 或 continue_with 中提取
            raise RuntimeError(f"无法提取 verification flow ID: {result}")
        print(f"[+] verification flow_id={verif_flow_id}")
        return verif_flow_id

    def _extract_verification_flow(self, result: dict) -> str:
        """从注册响应中提取 verification flow ID"""
        # continue_with 数组
        for item in result.get("continue_with", []):
            if item.get("action") == "show_verification_ui":
                return item.get("flow", {}).get("id", "")
        # redirect_browser_to URL 解析
        redirect = result.get("redirect_browser_to", "")
        if redirect:
            m = re.search(r"flow=([a-f0-9\-]+)", redirect)
            if m:
                return m.group(1)
        return ""

    # ─────────────────────────── 邮箱验证 ───────────────────────────

    def verify_email(self, verif_flow_id: str, code: str) -> None:
        """提交邮箱验证码"""
        print(f"[+] 获取 verification flow csrf...")
        resp = self.session.get(
            f"{ORYBRIDGE}/self-service/verification/flows",
            params={"id": verif_flow_id},
            headers={"Referer": f"{BASE}/authorization/verification?flow={verif_flow_id}"},
        )
        resp.raise_for_status()
        flow = resp.json()
        csrf_token = _extract_csrf(flow)

        body = {
            "method": "code",
            "code": str(code),
            "csrf_token": csrf_token,
        }

        print(f"[+] 提交验证码 {code}...")
        resp = self.session.post(
            f"{BASE}/api/auth/update-verification",
            headers={"Referer": f"{BASE}/authorization/verification?flow={verif_flow_id}"},
            data={
                "flow": json.dumps(verif_flow_id),
                "updateVerificationFlowBody": json.dumps(body),
            },
        )
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"验证失败 {resp.status_code}: {resp.text[:300]}")
        print(f"[+] 邮箱验证成功")

    # ─────────────────────────── 登录流程 ───────────────────────────

    def login(self, email: str, password: str) -> None:
        """登录已有账户，session cookie 自动保存"""
        print(f"[+] 获取登录 flow...")
        resp = self.session.get(
            f"{ORYBRIDGE}/self-service/login/browser",
            headers={"Referer": f"{BASE}/authorization/login"},
        )
        resp.raise_for_status()
        flow = resp.json()
        action = flow["ui"]["action"]
        csrf_token = _extract_csrf(flow)
        print(f"[+] login action={action}")

        login_headers = {
            "Content-Type": "application/json",
            "Referer": f"{BASE}/authorization/login",
            "Accept": "application/json",
        }
        login_body = {
            "method": "password",
            "identifier": email,
            "password": password,
            "csrf_token": csrf_token,
            "transient_payload": {},
        }

        print(f"[+] 提交登录（无 Turnstile）...")
        resp = self.session.post(action, headers=login_headers, json=login_body)

        if resp.status_code not in (200, 201):
            api_key = os.getenv("CAPTCHA_API_KEY", "")
            if not api_key:
                raise RuntimeError(f"登录失败 {resp.status_code}: {resp.text[:300]}")
            print(f"[+] 需要 Turnstile，解码中...")
            turnstile_token = self._solve_turnstile(f"{BASE}/authorization/login")
            login_body["transient_payload"] = {"turnstile_token": turnstile_token}
            resp = self.session.post(action, headers=login_headers, json=login_body)
            if resp.status_code not in (200, 201):
                raise RuntimeError(f"登录失败 {resp.status_code}: {resp.text[:300]}")

        print(f"[+] 登录成功")

    # ─────────────────────────── Chat 操作 ───────────────────────────

    def create_chat(self) -> str:
        """获取或创建对话

        录制分析：
        1. GET /api/chat/chats  → 若已有对话直接取第一个 id
        2. 若无对话：GET /chat.data?_routes=...  触发 Remix SSR loader 服务端创建
        3. 再次 GET /api/chat/chats 取新建的 chat_id
        """
        chats_url = f"{BASE}/api/chat/chats"
        params = {"mode": "chat", "offset": "0", "limit": "100"}
        headers = {"Content-Type": "application/json", "Referer": f"{BASE}/chat"}

        resp = self.session.get(chats_url, params=params, headers=headers)
        resp.raise_for_status()
        items = resp.json().get("items", [])
        if items:
            chat_id = items[0]["id"]
            print(f"[+] 使用已有 chat_id={chat_id}")
            return chat_id

        self.session.get(
            f"{BASE}/chat.data",
            params={"_routes": "root%2Cdomains%2Fauth%2Froutes%2FLoggedInLayout%2Cdomains%2Fchat-exp%2Froutes%2FChatHistoryLayout%2Cchat-exp-chat-page"},
            headers={"Referer": f"{BASE}/chat"},
        )

        resp2 = self.session.get(chats_url, params=params, headers=headers)
        resp2.raise_for_status()
        items2 = resp2.json().get("items", [])
        if not items2:
            raise RuntimeError("无法创建 chat，chats 列表仍为空")
        chat_id = items2[0]["id"]
        print(f"[+] 新建 chat_id={chat_id}")
        return chat_id

    def upload_file(self, chat_id: str, file_path: str) -> str:
        """上传文件到对话，返回 file_id"""
        filename = os.path.basename(file_path)
        print(f"[+] 上传文件 {filename}...")
        with open(file_path, "rb") as f:
            resp = self.session.post(
                f"{BASE}/api/chat/{chat_id}",
                data={"action": json.dumps("chat_file_upload")},
                files={"file": (filename, f)},
            )
        resp.raise_for_status()
        result = resp.json()
        file_id = result.get("file_id") or result.get("id") or result.get("fileId")
        if not file_id:
            raise RuntimeError(f"上传文件失败: {resp.text[:300]}")
        print(f"[+] file_id={file_id}")
        return file_id

    def chat_completion(
        self,
        chat_id: str,
        message: str,
        file_ids: list = None,
        model_id: str = None,
        enable_web_search: bool = False,
        enable_code_interpreter: bool = False,
        last_message_id: str = None,
    ) -> tuple:
        """发送消息并获取完整回复（SSE 流式解析）

        真实抓包格式：
        - action = '"chat_completion"'  (JSON 双引号)
        - chatId  = '"uuid"'
        - data    = JSON string of { handler, user_message, tools, ... }
        """
        # handler: type=auto 时服务端自动选模型；有 model_id 时用 model 类型
        if model_id:
            handler = {"id": model_id, "type": "model", "fallbacks": True}
        else:
            handler = {"type": "auto", "fallbacks": True}

        user_message = {
            "text": message,
            "client_metadata": {},
            "files": [{"file_id": fid} for fid in (file_ids or [])],
        }

        data_obj = {
            "handler": handler,
            "user_message": user_message,
            "advanced_parameters": {
                "max_completion_tokens": 128000,
                "temperature": 1,
            },
            "functionalityHeader": "chat",
            "tools": {
                "web_search": {"enabled": enable_web_search},
                "deep_research": {"enabled": False},
                "code_interpreter": {"enabled": enable_code_interpreter},
            },
            "enabled_integrations": [],
            "chat": ({"last_message_id": last_message_id} if last_message_id else {}),
        }

        payload = {
            "action": json.dumps("chat_completion"),
            "chatId": json.dumps(chat_id),
            "data": json.dumps(data_obj),
        }

        print(f"[+] 发送消息: {message[:80]}...")
        resp = self.session.post(
            f"{BASE}/api/chat/{chat_id}",
            data=payload,
            headers={"Accept": "text/event-stream"},
            stream=True,
            timeout=120,
        )
        resp.raise_for_status()
        return self._parse_sse(resp)  # (text, message_id)

    def _parse_sse(self, resp: requests.Response) -> tuple:
        """解析 SSE 流，返回 (full_text, message_id)

        实际事件格式（录制确认）：
          event: chat.content.progress
          data: {"message_id":"...","session_id":"..."}

          event: chat.content.chunk
          data: {"content_type":"text","choice":0,"content":{"text":"..."}}

          event: chat.content.end
          data: {"success":true}
        """
        full_text = []
        message_id = None
        current_event = None

        for raw_line in resp.iter_lines(decode_unicode=True):
            if raw_line.startswith("event:"):
                current_event = raw_line[6:].strip()
            elif raw_line.startswith("data:"):
                data_str = raw_line[5:].strip()
                if not data_str or data_str == "[DONE]":
                    continue
                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                if current_event == "chat.content.progress" and not message_id:
                    message_id = data.get("message_id")
                elif current_event == "chat.content.chunk":
                    if data.get("content_type") == "text":
                        chunk = data.get("content", {}).get("text", "")
                        if chunk:
                            full_text.append(chunk)
                            print(chunk, end="", flush=True)
            elif raw_line == "":
                current_event = None

        print()
        return "".join(full_text), message_id
