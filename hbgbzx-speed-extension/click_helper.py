import argparse
import json
import threading
import traceback
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

LOCK = threading.Lock()


def ok(data=None):
    return {"ok": True, "data": data or {}}


def fail(message, data=None):
    return {"ok": False, "message": message, "data": data or {}}


class HelperCore:
    def __init__(self, debug_url: str):
        self.debug_url = debug_url

    @contextmanager
    def browser(self):
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(self.debug_url)
            try:
                yield browser
            finally:
                browser.close()

    def _all_pages(self, browser):
        pages = []
        for context in browser.contexts:
            pages.extend(context.pages)
        return pages

    def _find_page(self, browser, url_part: str):
        pages = self._all_pages(browser)
        matched = [page for page in pages if url_part in (page.url or "")]
        return matched[-1] if matched else None

    def health(self):
        with self.browser() as browser:
            pages = [{"url": page.url} for page in self._all_pages(browser)]
            return ok({"pages": pages, "debugUrl": self.debug_url})

    def click_course(self, payload):
        course_title = payload.get("courseTitle", "")
        page_index = int(payload.get("pageIndex", 0) or 0)
        page_url_part = payload.get("pageUrlPart", "study_center/my_course")
        timeout_ms = int(payload.get("timeoutMs", 15000) or 15000)

        with self.browser() as browser:
            page = self._find_page(browser, page_url_part)
            if not page:
                return fail("未找到课程列表页")

            target_card = None
            if course_title:
                card = page.locator("li.course_list").filter(has_text=course_title).first
                if card.count() > 0:
                    target_card = card

            if target_card is None:
                cards = page.locator("li.course_list")
                if cards.count() <= page_index:
                    return fail("未找到目标课程卡片", {"courseTitle": course_title, "pageIndex": page_index})
                target_card = cards.nth(page_index)

            button = target_card.locator(".Save").first
            if button.count() == 0:
                return fail("未找到开始学习按钮", {"courseTitle": course_title})

            before_pages = len(self._all_pages(browser))
            try:
                with page.context.expect_page(timeout=timeout_ms) as popup_info:
                    button.click(button="left", delay=60, timeout=timeout_ms)
                popup = popup_info.value
                popup.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
                return ok({
                    "pageCountBefore": before_pages,
                    "pageCountAfter": len(self._all_pages(browser)),
                    "popupUrl": popup.url,
                    "courseTitle": course_title,
                })
            except PlaywrightTimeoutError:
                current_url = page.url
                if "video_detail" in current_url:
                    return ok({
                        "pageCountBefore": before_pages,
                        "pageCountAfter": len(self._all_pages(browser)),
                        "popupUrl": current_url,
                        "courseTitle": course_title,
                        "sameTab": True,
                    })
                return fail("点击后未捕获到新窗口", {"courseTitle": course_title, "pageUrl": current_url})
            except PlaywrightError as error:
                return fail(str(error), {"courseTitle": course_title})

    def ensure_playing(self, payload):
        course_id = str(payload.get("courseId") or "")
        timeout_ms = int(payload.get("timeoutMs", 12000) or 12000)
        url_part = f"video_detail?id={course_id}" if course_id else "video_detail"

        with self.browser() as browser:
            page = self._find_page(browser, url_part)
            if not page:
                return fail("未找到视频页", {"courseId": course_id})

            try:
                page.wait_for_function(
                    "() => !!document.querySelector('video')",
                    timeout=timeout_ms,
                )
            except PlaywrightTimeoutError:
                return fail("视频元素加载超时", {"courseId": course_id, "url": page.url})

            page.wait_for_timeout(1200)

            def read_state():
                return page.evaluate(
                    """() => {
                        const video = document.querySelector('video');
                        if (!video) return { hasVideo: false, url: location.href };
                        const rect = video.getBoundingClientRect();
                        return {
                            hasVideo: true,
                            paused: !!video.paused,
                            ended: !!video.ended,
                            muted: !!video.muted,
                            currentTime: Number(video.currentTime || 0),
                            duration: Number(video.duration || 0),
                            x: rect.left + rect.width / 2,
                            y: rect.top + rect.height / 2,
                            width: rect.width,
                            height: rect.height,
                            url: location.href,
                        };
                    }"""
                )

            before = read_state()
            if not before.get("hasVideo"):
                return fail("未找到视频元素", before)

            if before.get("paused"):
                try:
                    page.mouse.click(before["x"], before["y"], delay=80)
                    page.wait_for_timeout(1400)
                except PlaywrightError as error:
                    return fail(str(error), before)

            after = read_state()
            if after.get("paused"):
                try:
                    page.keyboard.press("Space")
                    page.wait_for_timeout(1000)
                    after = read_state()
                except PlaywrightError:
                    pass

            return ok({"before": before, "after": after})


class RequestHandler(BaseHTTPRequestHandler):
    core: HelperCore = None

    def _send(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        return

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        if self.path != "/health":
            self._send(404, fail("not-found"))
            return
        with LOCK:
            try:
                self._send(200, self.core.health())
            except Exception as error:
                self._send(500, fail(str(error), {"trace": traceback.format_exc()}))

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            payload = {}

        with LOCK:
            try:
                if self.path == "/click-course":
                    result = self.core.click_course(payload)
                elif self.path == "/ensure-playing":
                    result = self.core.ensure_playing(payload)
                else:
                    self._send(404, fail("not-found"))
                    return
                self._send(200 if result.get("ok") else 400, result)
            except Exception as error:
                self._send(500, fail(str(error), {"trace": traceback.format_exc()}))


def main():
    parser = argparse.ArgumentParser(description="HBGBZX 浏览器点击助手")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--debug-url", default="http://127.0.0.1:9222")
    args = parser.parse_args()

    RequestHandler.core = HelperCore(args.debug_url)
    server = ThreadingHTTPServer((args.host, args.port), RequestHandler)
    print(f"helper listening on http://{args.host}:{args.port} -> {args.debug_url}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
