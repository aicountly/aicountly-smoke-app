#!/usr/bin/env python3
"""Stand-in for Tata Tele Business Services "Smartflo" click-to-call, per
flow-react-app/docs/TATA_TELE_CLICK_TO_CALL.md (the contract Flow's TataTeleClient implements):

  POST {api_base}/v1/click_to_call      Authorization: <token>   (raw token, no "Bearer")
       {agent_number, destination_number, caller_id, async: 1, get_call_id: 1}
  ->   200 {"success": true, "call_id": "<id>"}          (401 on a wrong token, 422 on a bad body)

and then, like Smartflo, pushes the call-status webhook to the URL registered for the account
(Flow: /api/public/telephony/tata/webhook?token=<TATA_TELE_WEBHOOK_SECRET>):
  1. {"call_id", "call_status": "ringing"}
  2. {"call_id", "call_status": "answered", "answer_stamp", "end_stamp", "billsec", "recording_url"}

Serves HTTPS (Flow refuses a non-https Smartflo base). Every request received and every webhook
sent (with Flow's answer) is appended to a JSON-lines file.

  tata_stub.py --port N --cert c.pem --key k.pem --token T --webhook-url URL --out calls.jsonl
"""

from __future__ import annotations

import argparse
import json
import ssl
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
IST = timezone(timedelta(hours=5, minutes=30))


def record(path: str, rec: dict) -> None:
    rec["ts"] = time.time()
    with LOCK:
        with open(path, "a") as fh:
            fh.write(json.dumps(rec) + "\n")


def push_webhooks(srv, call_id: str) -> None:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    now = datetime.now(IST)
    events = [
        {"call_id": call_id, "call_status": "ringing"},
        {"call_id": call_id, "call_status": "answered",
         "answer_stamp": now.strftime("%Y-%m-%d %H:%M:%S"),
         "end_stamp": (now + timedelta(seconds=95)).strftime("%Y-%m-%d %H:%M:%S"),
         "billsec": "95", "recording_url": f"https://recordings.smartflo.example/{call_id}.mp3"},
    ]
    for ev in events:
        time.sleep(srv.webhook_delay)
        req = urllib.request.Request(srv.webhook_url, data=json.dumps(ev).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with opener.open(req, timeout=20) as r:
                status, body = r.status, r.read().decode(errors="replace")
        except urllib.error.HTTPError as e:
            status, body = e.code, (e.read() or b"").decode(errors="replace")
        except Exception as e:
            status, body = 0, str(e)
        record(srv.out, {"kind": "webhook_sent", "payload": ev, "flow_status": status, "flow_body": body[:500]})


class Handler(BaseHTTPRequestHandler):
    server_version = "e2e-smartflo-stub/1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code: int, obj) -> None:
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self._send(200, {"ok": True, "service": "smartflo-stub"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        auth = self.headers.get("Authorization", "")
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            body = None
        rec = {"kind": "click_to_call", "path": self.path, "authorization": auth,
               "content_type": self.headers.get("Content-Type", ""), "body": body}
        if self.path.split("?")[0] != self.server.c2c_path:
            rec["answer"] = 404
            record(self.server.out, rec)
            self._send(404, {"success": False, "message": "Not found"})
            return
        if auth != self.server.token:
            rec["answer"] = 401
            record(self.server.out, rec)
            self._send(401, {"success": False, "message": "Invalid token"})
            return
        need = ("agent_number", "destination_number", "caller_id")
        if not isinstance(body, dict) or any(not str(body.get(k, "")).isdigit() for k in need):
            rec["answer"] = 422
            record(self.server.out, rec)
            self._send(422, {"success": False, "message": "agent_number, destination_number and caller_id are required digits"})
            return
        call_id = "sf-" + uuid.uuid4().hex[:16]
        rec["answer"] = 200
        rec["call_id"] = call_id
        record(self.server.out, rec)
        self._send(200, {"success": True, "message": "Originate successfully queued", "call_id": call_id})
        if self.server.webhook_url:
            threading.Thread(target=push_webhooks, args=(self.server, call_id), daemon=True).start()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--cert", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--path", default="/v1/click_to_call")
    ap.add_argument("--webhook-url", default="")
    ap.add_argument("--webhook-delay", type=float, default=0.5)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(a.cert, a.key)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    srv.token, srv.c2c_path, srv.webhook_url, srv.webhook_delay, srv.out = a.token, a.path, a.webhook_url, a.webhook_delay, a.out
    srv.serve_forever()


if __name__ == "__main__":
    main()
