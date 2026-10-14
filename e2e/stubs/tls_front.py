#!/usr/bin/env python3
"""HTTPS front door for a real service that the stack runs over plain HTTP (php -S speaks no TLS).
Used where a caller refuses anything but https:// — e.g. Flow's PORTAL_ACCOUNT_RESTORE_URL. It is
a dumb pass-through: method, path, query, headers and body go to the target unchanged and the
answer comes back unchanged (the certificate is issued by the stack's own CA).

  tls_front.py --port N --cert c.pem --key k.pem --target http://127.0.0.1:M --log access.log
"""

from __future__ import annotations

import argparse
import http.client
import ssl
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
       "transfer-encoding", "upgrade", "host", "content-length"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        t = urlsplit(self.server.target)
        conn = http.client.HTTPConnection(t.hostname, t.port, timeout=60)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        headers["Host"] = f"{t.hostname}:{t.port}"
        headers["X-Forwarded-Proto"] = "https"
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            r = conn.getresponse()
            data = r.read()
            self.send_response(r.status, r.reason)
            for k, v in r.getheaders():
                if k.lower() not in HOP:
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            status = r.status
        except Exception as e:  # target down
            msg = f"tls_front: upstream error {e}".encode()
            self.send_response(502)
            self.send_header("Content-Length", str(len(msg)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(msg)
            status = 502
        finally:
            conn.close()
        with open(self.server.log, "a") as fh:
            fh.write(f"{time.strftime('%H:%M:%S')} {self.command} {self.path} -> {status}\n")
        self.close_connection = True

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _proxy


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--cert", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--log", required=True)
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(a.cert, a.key)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    srv.target, srv.log = a.target, a.log
    srv.serve_forever()


if __name__ == "__main__":
    main()
