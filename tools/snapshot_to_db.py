"""Turn a phone snapshot (finance-snapshot.fmsnap) back into data/finance.db.

Use it to restore your data on a new PC: the snapshot is a full copy of the database, except for the
remembered PDF passwords and the snapshot settings, which never leave the PC.

    python tools/snapshot_to_db.py "G:\\My Drive\\Finance Master\\finance-snapshot.fmsnap"

Asks for the snapshot passphrase. Won't overwrite an existing database unless you pass --force.
"""
import argparse
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import snapshot  # noqa: E402
from backend.config import DB_PATH  # noqa: E402
from backend.db import init_db  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--force", action="store_true", help=f"replace {DB_PATH} if it exists")
    args = parser.parse_args()

    if DB_PATH.exists() and not args.force:
        sys.exit(f"{DB_PATH} already exists. Pass --force to replace it.")
    blob = args.snapshot.read_bytes()
    passphrase = getpass.getpass("Snapshot passphrase: ")
    try:
        meta, db_bytes = snapshot.unpack(snapshot.decrypt(blob, passphrase))
    except ValueError as e:
        sys.exit(str(e))
    except Exception:  # cryptography's InvalidTag
        sys.exit("That passphrase didn't unlock the snapshot.")

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    DB_PATH.write_bytes(db_bytes)
    init_db()  # brings an older snapshot up to this version's schema
    print(f"Restored {meta.get('transactions')} transactions, {meta.get('accounts')} accounts "
          f"(snapshot from {meta.get('created')}) to {DB_PATH}")


if __name__ == "__main__":
    main()
