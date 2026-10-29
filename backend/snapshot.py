"""Locked snapshot of the database for the phone app.

The PC writes `finance-snapshot.fmsnap` into a folder you choose (e.g. your Google Drive folder). The
phone app opens it read-only. The file is encrypted with your passphrase, so the cloud only ever
holds unreadable bytes. The passphrase is kept in Windows Credential Manager, never in the database.

File layout (the phone decrypts it with WebCrypto, see frontend/src/phone/snapshot.ts):
    b"FMS1" | iterations: uint32 BE | salt: 16 bytes | iv: 12 bytes | AES-256-GCM ciphertext + tag
The header (first 36 bytes) is the GCM associated data. The key is PBKDF2-HMAC-SHA256(NFC passphrase,
salt, iterations). The plaintext is gzip(meta_len: uint32 BE | meta JSON | SQLite database bytes).
"""
import gzip
import hashlib
import json
import os
import sqlite3
import string
import sys
import struct
import threading
import unicodedata
from datetime import datetime
from pathlib import Path

import keyring

from .config import DB_PATH, ROOT

MAGIC = b"FMS1"
ITERATIONS = 600_000
FILE_NAME = "finance-snapshot.fmsnap"
MIN_PASSPHRASE = 10
SERVICE = "finance-dashboard-snapshot"
_USER = f"passphrase {ROOT}"  # per data folder, so the demo never touches your real passphrase
_FOLDER_KEY = "snapshot_folder"
_LAST_KEY = "snapshot_last"
# settings rows the phone has no use for
_PRIVATE_SETTINGS = ("pdf_password_labels", _FOLDER_KEY, _LAST_KEY)


def _key(passphrase: str, salt: bytes, iterations: int) -> bytes:
    # NFC so a passphrase typed on the phone's keyboard matches the one typed on the PC
    return hashlib.pbkdf2_hmac("sha256", unicodedata.normalize("NFC", passphrase).encode(), salt, iterations, dklen=32)


def encrypt(plain: bytes, passphrase: str, iterations: int = ITERATIONS) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    salt, iv = os.urandom(16), os.urandom(12)
    header = MAGIC + struct.pack(">I", iterations) + salt + iv
    return header + AESGCM(_key(passphrase, salt, iterations)).encrypt(iv, plain, header)


def decrypt(blob: bytes, passphrase: str) -> bytes:
    """Inverse of encrypt (the phone does this in JavaScript; here for tests)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if blob[:4] != MAGIC:
        raise ValueError("not a Finance Master snapshot")
    (iterations,) = struct.unpack(">I", blob[4:8])
    salt, iv, header = blob[8:24], blob[24:36], blob[:36]
    return AESGCM(_key(passphrase, salt, iterations)).decrypt(iv, blob[36:], header)


def pack(db_bytes: bytes, meta: dict) -> bytes:
    m = json.dumps(meta).encode()
    return gzip.compress(struct.pack(">I", len(m)) + m + db_bytes, 6)


def unpack(plain: bytes) -> tuple[dict, bytes]:
    raw = gzip.decompress(plain)
    (n,) = struct.unpack(">I", raw[:4])
    return json.loads(raw[4:4 + n]), raw[4 + n:]


def database_copy(db_path: Path = DB_PATH) -> tuple[bytes, dict]:
    """Consistent copy of the live database (safe while the app runs), minus PC-only settings."""
    src = sqlite3.connect(db_path)
    mem = sqlite3.connect(":memory:")
    try:
        src.backup(mem)
    finally:
        src.close()
    mem.execute(f"DELETE FROM settings WHERE key IN ({','.join('?' * len(_PRIVATE_SETTINGS))})", _PRIVATE_SETTINGS)
    mem.commit()
    mem.execute("VACUUM")
    meta = {
        "app": "Finance Master",
        "format": 1,
        "created": datetime.now().astimezone().isoformat(timespec="seconds"),
        "transactions": mem.execute("SELECT count(*) FROM transactions").fetchone()[0],
        "accounts": mem.execute("SELECT count(*) FROM accounts WHERE archived = 0").fetchone()[0],
    }
    data = mem.serialize()
    mem.close()
    return data, meta


# ---------------------------------------------------------------- settings


def _get(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def _set(conn: sqlite3.Connection, key: str, value: str | None) -> None:
    if value is None:
        conn.execute("DELETE FROM settings WHERE key = ?", (key,))
    else:
        conn.execute("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (key, value))


def _passphrase() -> str | None:
    try:
        return keyring.get_password(SERVICE, _USER)
    except Exception:
        return None


def suggested_folders() -> list[str]:
    """Google Drive / OneDrive folders on this PC, each with a Finance Master subfolder."""
    found: list[Path] = []
    home = Path.home()
    for letter in string.ascii_uppercase[3:]:  # Google Drive for desktop mounts as a drive, usually G:
        found += [Path(f"{letter}:/My Drive")]
    found += [home / "My Drive", home / "Google Drive", home / "Google Drive" / "My Drive"]
    if os.environ.get("OneDrive"):
        found.append(Path(os.environ["OneDrive"]))
    out = []
    for p in found:
        try:
            if p.is_dir():
                out.append(str(p / "Finance Master"))
        except OSError:
            pass
    return out


def status(conn: sqlite3.Connection) -> dict:
    folder = _get(conn, _FOLDER_KEY)
    last = _get(conn, _LAST_KEY)
    return {
        "folder": folder,
        "enabled": bool(folder and _passphrase()),
        "last": json.loads(last) if last else None,
        "suggestions": suggested_folders(),
        "file_name": FILE_NAME,
        "min_passphrase": MIN_PASSPHRASE,
    }


def configure(conn: sqlite3.Connection, folder: str, passphrase: str | None) -> None:
    path = Path(folder.strip().strip('"')).expanduser()
    if not path.is_absolute():
        raise ValueError("Choose a full folder path, e.g. G:\\My Drive\\Finance Master")
    if not path.parent.exists():
        raise ValueError(f"{path.parent} doesn't exist. Is Google Drive for desktop running?")
    path.mkdir(exist_ok=True)
    if passphrase is not None:
        if len(passphrase) < MIN_PASSPHRASE:
            raise ValueError(f"Use a passphrase of at least {MIN_PASSPHRASE} characters, e.g. four random words")
        keyring.set_password(SERVICE, _USER, passphrase)
    elif not _passphrase():
        raise ValueError("Choose a passphrase")
    _set(conn, _FOLDER_KEY, str(path))


def disable(conn: sqlite3.Connection) -> None:
    try:
        keyring.delete_password(SERVICE, _USER)
    except Exception:
        pass
    _set(conn, _FOLDER_KEY, None)
    _set(conn, _LAST_KEY, None)


# ---------------------------------------------------------------- writing

_lock = threading.Lock()
_timer: threading.Timer | None = None


def write(conn: sqlite3.Connection) -> dict | None:
    """Write the snapshot now if it's set up. Returns what was written (None when switched off)."""
    folder, passphrase = _get(conn, _FOLDER_KEY), _passphrase()
    if not folder or not passphrase:
        return None
    with _lock:
        db_bytes, meta = database_copy()
        blob = encrypt(pack(db_bytes, meta), passphrase)
        target = Path(folder) / FILE_NAME
        tmp = target.with_suffix(".tmp")
        tmp.write_bytes(blob)
        os.replace(tmp, target)  # sync clients never see a half-written file
    last = {"time": meta["created"], "path": str(target), "size": len(blob), "transactions": meta["transactions"]}
    _set(conn, _LAST_KEY, json.dumps(last))
    return last


def write_soon(delay: float = 20.0) -> None:
    """Rewrite the snapshot a little after the last change (edits often come in bursts)."""
    global _timer
    if sys.platform == "emscripten":
        return  # the web app saves the database to Drive itself (and browsers have no threads)
    if _timer:
        _timer.cancel()
    _timer = threading.Timer(delay, _write_in_background)
    _timer.daemon = True
    _timer.start()


def _write_in_background() -> None:
    from .db import session

    try:
        with session() as conn:
            write(conn)
    except Exception as e:  # a locked/offline Drive folder shouldn't break the dashboard
        print(f"Phone snapshot not written: {e}")
