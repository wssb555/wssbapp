"""
Nexos.ai 自动化客户端演示

使用前先创建 .env 文件（参考 .env.example）

流程 1 - 注册新账户 + 对话:
    python demo.py --mode register

流程 2 - 已有账户登录 + 对话:
    python demo.py --mode login

流程 3 - 仅对话（已有 session）:
    python demo.py --mode chat
"""
import argparse
import os
from dotenv import load_dotenv
from nexos_client import NexosClient
from email_service import EmailService

load_dotenv()


def flow_register_and_chat(client: NexosClient):
    """完整注册流程：创建临时邮箱 → 注册 → 验证 → 对话"""
    email_svc = EmailService()

    _, email = email_svc.create_email()
    if not email:
        raise RuntimeError("创建临时邮箱失败")
    print(f"[+] 临时邮箱: {email}")

    password = "AutoTest@2026!"

    # 注册
    verif_flow_id = client.register(email, password)

    # 获取验证码
    print("[+] 等待验证码...")
    code = email_svc.fetch_verification_code(email)
    if not code:
        raise RuntimeError("获取验证码超时")
    print(f"[+] 验证码: {code}")

    # 验证邮箱
    client.verify_email(verif_flow_id, code)

    # 创建对话并发送消息
    _do_chat(client)

    # 清理
    email_svc.delete_email(email)


def flow_login_and_chat(client: NexosClient):
    """登录已有账户 → 对话"""
    email = os.getenv("NEXOS_EMAIL")
    password = os.getenv("NEXOS_PASSWORD")
    if not email or not password:
        raise ValueError("需要设置 NEXOS_EMAIL 和 NEXOS_PASSWORD")

    client.login(email, password)
    _do_chat(client)


def _do_chat(client: NexosClient):
    """创建对话，可选上传文件，发送消息（支持多轮）"""
    chat_id = client.create_chat()

    # 如果有测试文件则上传
    test_file = os.getenv("TEST_FILE_PATH", "")
    file_ids = []
    if test_file and os.path.exists(test_file):
        file_id = client.upload_file(chat_id, test_file)
        file_ids.append(file_id)

    # 第一条消息
    message = os.getenv("TEST_MESSAGE", "请介绍一下你自己，你能做什么？")
    reply, last_msg_id = client.chat_completion(
        chat_id=chat_id,
        message=message,
        file_ids=file_ids,
    )
    print(f"\n[+] 回复:\n{reply}")

    # 示例：第二条消息（携带 last_message_id 维持对话上下文）
    second = os.getenv("TEST_MESSAGE_2", "")
    if second:
        reply2, _ = client.chat_completion(
            chat_id=chat_id,
            message=second,
            last_message_id=last_msg_id,
        )
        print(f"\n[+] 回复2:\n{reply2}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["register", "login", "chat"], default="login")
    parser.add_argument("--solver", choices=["2captcha", "capsolver"], default="2captcha")
    args = parser.parse_args()

    client = NexosClient(solver=args.solver)

    if args.mode == "register":
        flow_register_and_chat(client)
    elif args.mode == "login":
        flow_login_and_chat(client)
    else:
        _do_chat(client)


if __name__ == "__main__":
    main()
