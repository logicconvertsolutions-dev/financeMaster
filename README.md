# Finance Master

Personal finance dashboard. The PC imports bank statements and keeps everything in a local SQLite
database. The phone app, hosted on Vercel, shows a read-only, encrypted copy of that database.

## How it fits together

```
statements folder (local, or Google Drive)  ──►  PC: backend/ (FastAPI) + data/finance.db + frontend/dist
                                                   │  writes after every change
                                                   ▼
                                     finance-snapshot.fmsnap in your Drive folder (AES-256-GCM)
                                                   │  picked in the phone's file picker
                                                   ▼
                       phone app (Vercel PWA): decrypts in the browser, runs the same backend in Pyodide
```

- **Statements:** keep them in `statements/` or in a Google Drive folder. To add one from your phone, save
  it into that Drive folder; the PC imports it the next time the dashboard opens. On the PC you can also
  drop files onto the dashboard.
- **The phone app is view-only.** Make changes on the PC; they reach the phone with the next snapshot
  (set up under *Categories & settings → Your data → Phone app*).
- **The database stays on the PC.** Don't put `data/` inside a sync folder.

## Run on a PC

Needs Python 3.12+ and Node 20+.

```
pip install -r requirements.txt
start.bat                                   # Windows: builds the dashboard on first run, then starts it
python run.py                               # any OS (build the dashboard first: cd frontend && npm install && npm run build)
python run.py --statements "G:\My Drive\Finance\statements"    # statements in Google Drive
```

You can also set `FINANCE_STATEMENTS_DIR` instead of passing `--statements`.

## Phone app (Vercel)

```
cd frontend
npm install
npm run build:phone        # → frontend/dist-phone (downloads Pyodide's wheels once into .pyodide-cache)
npx vercel deploy dist-phone --prod
```

## Restore your data from a snapshot

```
python tools/snapshot_to_db.py "G:\My Drive\Finance Master\finance-snapshot.fmsnap"
```

The snapshot has everything except the remembered PDF passwords and the original statement files.

## Where this code came from

The original project folder was lost with a laptop. The only surviving copy was the phone app deployed on
Vercel (`finance-master-phone`), saved as built in `recovered/phone-dist/`.

- `backend/` is byte-for-byte what was deployed: the phone build bundles every `.py` file as text.
  `tools/extract_backend.py` decodes them. After that commit, the only change is the statements-folder option.
- `frontend/src/` was rebuilt from the minified bundle (see `tools/frontend-recovery/unbundle.mjs`). Every
  page was checked against the original bundle on the same data and renders the same text. Names of
  components, props and API fields are real; short local variable names inside functions (`e`, `t`, `n`…)
  are left over from minification.
- Not recovered: tests, and anything else that was never deployed.
