#!/usr/bin/env python3
"""Stand-in for the Itwalk e-mail API (https://e.api.itwalk.in/email/1/send and /email/3/send) that
Console, Flow, Manage and my.aicountly post to. Accepts the same multipart (v1) and JSON (v3)
requests, answers like Itwalk ({bulkId, messages:[{to, messageId, status}]}) and appends every
message to a JSON-lines file the scenarios assert on. Nothing is delivered anywhere.

  mail_stub.py --port N --out messages.jsonl [--keys key=label,...]

The sending service is recognised by its API key (`Authorization: App <key>`): the harness gives
every service its own key, so a captured message says which product sent it.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
import uuid
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()


def parse_multipart(content_type: str, body: bytes) -> tuple[dict[str, str], list[str]]:
    msg = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
    fields: dict[str, str] = {}
    files: list[str] = []
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        filename = part.get_filename()
        if filename:
            files.append(filename)
            continue
        if name:
            payload = part.get_payload(decode=True) or b""
            fields[str(name)] = payload.decode("utf-8", errors="replace")
    return fields, files


class Handler(BaseHTTPRequestHandler):
    server_version = "e2e-itwalk-stub/1"

    def log_message(self, fmt, *args):  # quiet; the jsonl file is the record
        pass

    def _send(self, code: int, obj) -> None:
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # health
        self._send(200, {"ok": True, "service": "itwalk-stub"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        auth = self.headers.get("Authorization", "")
        key = auth[4:].strip() if auth.startswith("App ") else ""
        if not key:
            self._send(401, {"requestError": {"serviceException": {"text": "Invalid login details"}}})
            return
        ctype = self.headers.get("Content-Type", "")
        files: list[str] = []
        if ctype.startswith("multipart/form-data"):
            fields, files = parse_multipart(ctype, body)
        elif ctype.startswith("application/json"):
            try:
                fields = {k: (v if isinstance(v, str) else json.dumps(v)) for k, v in json.loads(body or b"{}").items()}
            except ValueError:
                self._send(400, {"requestError": {"serviceException": {"text": "bad json"}}})
                return
        else:
            fields = {}
            for pair in body.decode(errors="replace").split("&"):
                if "=" in pair:
                    import urllib.parse
                    k, v = pair.split("=", 1)
                    fields[urllib.parse.unquote_plus(k)] = urllib.parse.unquote_plus(v)
        to = fields.get("to", "")
        mid = uuid.uuid4().hex
        rec = {
            "ts": time.time(),
            "sender_service": self.server.keys.get(key, "unknown-key"),
            "path": self.path,
            "mode": "multipart" if ctype.startswith("multipart") else ("json" if "json" in ctype else "form"),
            "from": fields.get("from", ""),
            "to": to,
            "reply_to": fields.get("replyTo", ""),
            "subject": fields.get("subject", ""),
            "html": fields.get("html", ""),
            "text": fields.get("text", ""),
            "attachments": files,
            "message_id": mid,
        }
        with LOCK:
            with open(self.server.out, "a") as fh:
                fh.write(json.dumps(rec) + "\n")
        self._send(200, {"bulkId": uuid.uuid4().hex,
                         "messages": [{"to": to, "messageId": mid,
                                       "status": {"groupId": 1, "groupName": "PENDING", "id": 26,
                                                  "name": "PENDING_ACCEPTED", "description": "Message accepted"}}]})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--keys", default="", help="comma-separated key=label")
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    srv.out = a.out
    srv.keys = dict(kv.split("=", 1) for kv in a.keys.split(",") if "=" in kv)
    srv.serve_forever()


if __name__ == "__main__":
    main()
