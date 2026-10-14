"""A small HTTP client for the scenarios (stdlib only, never uses a proxy, trusts the stack CA).
Every call is appended to STATE/logs/http.calls.log so a failed scenario can be read back."""

from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from . import config


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802
        return None


def _ctx() -> ssl.SSLContext:
    ca = config.STATE / "tls" / "ca.pem"
    return ssl.create_default_context(cafile=str(ca)) if ca.exists() else ssl.create_default_context()


@dataclass
class Resp:
    status: int
    body: bytes
    headers: dict[str, str]
    url: str

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    @property
    def json(self) -> Any:
        try:
            return json.loads(self.body.decode("utf-8"))
        except Exception:
            return None

    def __repr__(self) -> str:
        return f"<{self.status} {self.url} {self.text[:400]!r}>"


def request(method: str, url: str, *, json_body: Any = None, data: bytes | None = None, headers: dict | None = None,
            bearer: str | None = None, query: dict | None = None, timeout: float = 60, follow: bool = False) -> Resp:
    if query:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(query)
    h = {"Accept": "application/json"}
    if json_body is not None:
        data = json.dumps(json_body).encode()
        h["Content-Type"] = "application/json"
    if bearer:
        h["Authorization"] = f"Bearer {bearer}"
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    handlers: list = [urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=_ctx())]
    if not follow:
        handlers.append(_NoRedirect())
    opener = urllib.request.build_opener(*handlers)
    t0 = time.time()
    try:
        with opener.open(req, timeout=timeout) as r:
            resp = Resp(r.status, r.read(), {k.lower(): v for k, v in r.headers.items()}, url)
    except urllib.error.HTTPError as e:
        resp = Resp(e.code, e.read() or b"", {k.lower(): v for k, v in (e.headers or {}).items()}, url)
    except Exception as e:  # connection refused, timeout
        resp = Resp(0, str(e).encode(), {}, url)
    with open(config.STATE / "logs" / "http.calls.log", "a") as fh:
        sent = (data or b"")[:600].decode("utf-8", errors="replace")
        fh.write(f"{time.strftime('%H:%M:%S')} {method} {url} ({time.time() - t0:.2f}s) -> {resp.status}\n"
                 f"  > {sent}\n  < {resp.text[:1200]}\n")
    return resp


def get(url: str, **kw) -> Resp:
    return request("GET", url, **kw)


def post(url: str, **kw) -> Resp:
    return request("POST", url, **kw)


def put(url: str, **kw) -> Resp:
    return request("PUT", url, **kw)


def delete(url: str, **kw) -> Resp:
    return request("DELETE", url, **kw)


def multipart(fields: dict[str, str], files: dict[str, tuple[str, str, bytes]]) -> tuple[bytes, str]:
    """(body, content-type) for a multipart/form-data upload; files: name -> (filename, mime, bytes)."""
    import uuid
    boundary = "----e2e" + uuid.uuid4().hex
    out = b""
    for k, v in fields.items():
        out += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").encode()
    for k, (fn, mime, data) in files.items():
        out += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fn}\"\r\n"
                f"Content-Type: {mime}\r\n\r\n").encode() + data + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return out, f"multipart/form-data; boundary={boundary}"


def png(width: int = 8, height: int = 8) -> bytes:
    """A small valid PNG (so content sniffing on the receiving side accepts it)."""
    import struct
    import zlib
    raw = b"".join(b"\x00" + bytes([200, 30, 30]) * width for _ in range(height))

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
