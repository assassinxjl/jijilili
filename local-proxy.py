#!/usr/bin/env python3
# local-proxy.py —— jijilili-app「智能推荐」本机 CORS 代理
# 用途：浏览器因 CORS 无法直连 bayesdl，用本机代理在服务端转发，再经 cloudflared 隧道暴露成 HTTPS 地址给手机用。
# 依赖：仅 Python 标准库，无需 pip install。
# 运行：python local-proxy.py   （默认监听 0.0.0.0:8787，本机与局域网均可访问）
# 配合：在另一个终端运行  cloudflared tunnel --url http://localhost:8787
#       然后把 cloudflared 打印的 https://xxx.trycloudflare.com 填到 App 的「代理地址（可选）」

import json
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8787

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
}


def proxy(endpoint, api_key, model, messages):
    if not endpoint or not api_key:
        return 400, {"error": "缺少 endpoint 或 apiKey"}
    # 自动补齐 /chat/completions
    upstream = endpoint if endpoint.endswith("/chat/completions") else endpoint.rstrip("/") + "/chat/completions"
    payload = json.dumps({"model": model or "glm-5.1", "messages": messages or []}).encode("utf-8")
    req = urllib.request.Request(upstream, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + api_key)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 502, json.dumps({"error": str(e)})


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        # 预检请求直接放行
        self._send(204, b"")

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw or b"{}")
        except Exception as e:
            self._send(400, json.dumps({"error": "请求体解析失败: " + str(e)}))
            return
        code, out = proxy(
            data.get("endpoint"), data.get("apiKey"), data.get("model"), data.get("messages")
        )
        self._send(code, out)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print("本地代理已启动: http://localhost:%d" % PORT)
    print("下一步：在另一个终端运行  cloudflared tunnel --url http://localhost:%d" % PORT)
    print("       然后把 cloudflared 给出的 https://xxx.trycloudflare.com 填到 App 的「代理地址（可选）」")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
