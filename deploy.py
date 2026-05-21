#!/usr/bin/env python3
"""
Deploy the minified DEEPER bookmarklet to CoreServer.

Reads FTP credentials from ~/deeper/.deploy-env (the existing DEEPER deploy
config — same CoreServer host, same target domain). Uploads exactly one
file: dist/bookmarklet.min.js → /<REMOTE_DIR>/bookmarklet.min.js.

Usage:
    python3 deploy.py             # full deploy (upload + verify)
    python3 deploy.py --check     # dry-run: load env, connect, list remote, exit
"""

import os
import sys
import urllib.request
from ftplib import FTP
from pathlib import Path

REPO = Path(__file__).resolve().parent
LOCAL_FILE = REPO / "dist" / "bookmarklet.min.js"
REMOTE_FILENAME = "bookmarklet.min.js"
ENV_PATH = Path.home() / "deeper" / ".deploy-env"
VERIFY_URL = "https://deepers.site/bookmarklet.min.js"


def load_env(path: Path) -> dict[str, str]:
    config: dict[str, str] = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                key, _, val = line.partition("=")
                config[key.strip()] = val.strip()
    return config


def main() -> int:
    dry_run = "--check" in sys.argv

    if not LOCAL_FILE.exists():
        print(f"❌ {LOCAL_FILE} が存在しません。先に `npm run build` してください。")
        return 1
    print(f"📦 local : {LOCAL_FILE} ({LOCAL_FILE.stat().st_size} bytes)")

    if not ENV_PATH.exists():
        print(f"❌ {ENV_PATH} が見つかりません")
        return 1
    env = load_env(ENV_PATH)
    host = env["FTP_HOST"]
    user = env["FTP_USER"]
    password = env["FTP_PASS"]
    remote_dir = env.get("REMOTE_DIR", "/public_html")
    print(f"🌐 host  : {host}")
    print(f"📁 remote: {remote_dir}/{REMOTE_FILENAME}")

    ftp = FTP(host)
    ftp.login(user, password)
    ftp.encoding = "utf-8"
    ftp.cwd(remote_dir)
    print(f"✅ FTP connected, cwd={ftp.pwd()}")

    if dry_run:
        print("\n--check mode: 接続のみ確認、アップロードはしません")
        print("Remote root の中身（上位 30 件）:")
        listing = []
        ftp.retrlines("LIST", listing.append)
        for line in listing[:30]:
            print(f"  {line}")
        ftp.quit()
        return 0

    # Actual upload
    with open(LOCAL_FILE, "rb") as f:
        ftp.storbinary(f"STOR {REMOTE_FILENAME}", f)
    print(f"⬆️  uploaded {REMOTE_FILENAME}")
    ftp.quit()

    # HTTPS verify
    print(f"\n🔍 verifying via {VERIFY_URL} ...")
    try:
        with urllib.request.urlopen(VERIFY_URL, timeout=15) as resp:
            body = resp.read()
            print(f"  HTTP {resp.status}  Content-Length: {len(body)}  Content-Type: {resp.headers.get('Content-Type')}")
            local_size = LOCAL_FILE.stat().st_size
            if len(body) == local_size:
                print(f"  ✅ size matches ({local_size} bytes)")
            else:
                print(f"  ⚠️ size mismatch: remote={len(body)} local={local_size}")
    except Exception as e:
        print(f"  ⚠️ HTTPS verify failed: {e}")
        return 2

    print("\n✨ deploy complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
