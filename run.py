"""Start the dashboard on this PC and open it in the browser.

    python run.py                                   # statements in .\\statements
    python run.py --statements "G:\\My Drive\\Finance\\statements"   # statements in a Google Drive folder

If a server is already running it is reused, unless its code is older than the files on disk.
"""
import argparse
import json
import os
import sys
import threading
import urllib.request
import webbrowser


def running_status(url: str) -> dict | None:
    try:
        with urllib.request.urlopen(f"{url}/api/status", timeout=2) as r:
            return json.load(r)
    except Exception:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Finance Master")
    parser.add_argument("--statements", help="folder to read statements from (default: statements/ next to this file)")
    parser.add_argument("--no-browser", action="store_true", help="don't open the dashboard in a browser")
    args = parser.parse_args()
    if args.statements:
        os.environ["FINANCE_STATEMENTS_DIR"] = args.statements  # read by backend.config on import

    from backend.config import HOST, PORT, STATEMENTS_DIR, code_version

    url = f"http://{HOST}:{PORT}"
    status = running_status(url)
    if status:
        if status.get("code_version") == code_version():
            print(f"Finance Master is already running at {url}")
            if not args.no_browser:
                webbrowser.open(url)
            return
        sys.exit(f"An older Finance Master (pid {status.get('pid')}) is still running on {url}. Close it, then run this again.")

    import uvicorn

    print(f"Statements folder: {STATEMENTS_DIR}")
    print(f"Finance Master: {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(1.5, webbrowser.open, args=(url,)).start()
    uvicorn.run("backend.app:app", host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
