# Finance Master

Personal finance dashboard. The PC imports bank statements and keeps everything in a local SQLite
database. The phone app, hosted on Vercel, shows a read-only, encrypted copy of that database.

## How it fits together

```
statements folder (local, or Google Drive)  ──►  PC: backend/ (FastAPI) + data/finance.db
                                                   │  writes after every change
                                                   ▼
                                     finance-snapshot.fmsnap in your Drive folder (AES-256-GCM)
                                                   │  picked in the phone's file picker
                                                   ▼
                       phone app (Vercel PWA): decrypts in the browser, runs the same backend in Pyodide
```

- **Statements:** keep them in `statements/` or in a Google Drive folder. To add one from your phone, save
  it into that Drive folder; the PC imports it on its next scan.
- **The phone app is view-only.** Make changes on the PC; they reach the phone with the next snapshot.
- **The database stays on the PC.** Don't put `data/` inside a sync folder.

## Run on a PC

```
pip install -r requirements.txt
python run.py                                                  # statements in .\statements
python run.py --statements "G:\My Drive\Finance\statements"    # statements in Google Drive
```

You can also set `FINANCE_STATEMENTS_DIR` instead of passing `--statements`.

## Restore your data from a snapshot

```
python tools/snapshot_to_db.py "G:\My Drive\Finance Master\finance-snapshot.fmsnap"
```

The snapshot has everything except the remembered PDF passwords and the original statement files.

## Where this code came from

The original project folder was lost with a laptop. `backend/` was recovered byte for byte from the
deployed phone build: `python tools/extract_backend.py recovered/phone-dist/assets/engine.worker-*.js`.
After that commit, the only change is the separate statements-folder option.
`recovered/phone-dist/` is the deployed build as fetched from Vercel. The React frontend in it is only
available minified and is being rebuilt in `frontend/`.
