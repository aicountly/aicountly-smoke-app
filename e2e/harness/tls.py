"""A throwaway CA and one leaf certificate (127.0.0.1 / localhost) for the stack's HTTPS stubs and
front doors. PHP is pointed at the CA with -d curl.cainfo / openssl.cafile, the scenarios' client
trusts it too; nothing outside STATE/tls ever sees it."""

from __future__ import annotations

import subprocess

from . import config

TLS = config.STATE / "tls"


def ensure() -> dict[str, str]:
    TLS.mkdir(parents=True, exist_ok=True)
    ca_key, ca, key, csr, crt, ext = (TLS / n for n in ("ca.key", "ca.pem", "leaf.key", "leaf.csr", "leaf.pem", "leaf.ext"))
    if not crt.exists():
        def run(*args: str) -> None:
            subprocess.run(["openssl", *args], check=True, capture_output=True)
        run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(ca_key), "-out", str(ca), "-days", "3",
            "-subj", "/CN=AICOUNTLY e2e throwaway CA")
        run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(csr), "-subj", "/CN=127.0.0.1")
        ext.write_text("basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n"
                       "extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n")
        run("x509", "-req", "-in", str(csr), "-CA", str(ca), "-CAkey", str(ca_key), "-CAcreateserial", "-out", str(crt),
            "-days", "3", "-extfile", str(ext))
    return {"ca": str(ca), "cert": str(crt), "key": str(key)}
