# Finance Master

Personal finance dashboard. Open the Vercel link on any phone or PC, sign in with Google, and it reads your
bank statements from a Google Drive folder. Upload a statement to that folder and it shows up.

## How it works

```
Google Drive folder ──────────────────────────────────────────────────┐
  2026-09/visa.pdf, Sam/2026-09/chequing.csv, …  (your statements)    │  sign in with Google;
  finance-snapshot.fmsnap                        (your data, encrypted)│  only new files are downloaded
                                                                       ▼
            web app (Vercel, built from this repo): the backend/ Python code runs in your browser (Pyodide),
            imports the statements, and saves the database back into the folder, encrypted with your passphrase
```

- **No server sees your data.** Vercel only serves the app's files; statements and data go straight between
  your browser and your Google Drive.
- **Every device sees the same data**, because they all open the same `finance-snapshot.fmsnap`. If two devices
  change things at the same time, the second one is told to reload instead of overwriting the first.
- **Family members:** a subfolder with a person's name (e.g. `Sam/`) holds their statements.
- **Month folders:** statements are filed under the month they cover (`2026-09/`). Deleted statements move
  to `_deleted/`; nothing in Drive is ever erased.
- **Passwords of locked PDFs** are saved inside your encrypted data.

## One-time setup

1. **Google sign-in** (free, about 10 minutes) in [Google Cloud Console](https://console.cloud.google.com/):
   - Create a project, then enable the **Google Drive API** (*APIs & Services → Library*).
   - *OAuth consent screen*: user type **External**, status **Testing**. Under *Test users*, add the Gmail
     address of everyone who will use the app (up to 100).
   - *Credentials → Create credentials → OAuth client ID → Web application*. Authorized JavaScript origins:
     `https://finance-master-phone.vercel.app` (and `http://localhost:4173` to try it locally).
   - Copy the **Client ID**.
2. **Vercel**: in the `finance-master-phone` project, set the environment variable
   `VITE_GOOGLE_CLIENT_ID` to that Client ID. Link the project to this GitHub repo with **Root Directory**
   `frontend`. `frontend/vercel.json` sets the build. Every push to `main` then deploys.
3. **Open the link**, sign in, paste the link of your Drive statements folder, and choose a passphrase.
   Use the same passphrase on every device.

## Develop

```
cd frontend && npm install
npm run build:web && npm run preview:web    # the web app at http://localhost:4173 (needs VITE_GOOGLE_CLIENT_ID in frontend/.env.local)
```

`npm run build:web` downloads Pyodide's wheels once into `frontend/.pyodide-cache` (or copies them from an
unpacked Pyodide release, if `PYODIDE_DIST` points to one).

## PC app (optional)

The same backend also runs as a local server, with your statements in a folder on the PC (including a
Google Drive for desktop folder). It reads and writes the same `finance-snapshot.fmsnap` format, but don't
use it and the web app on the same folder at the same time.

```
pip install -r requirements.txt
start.bat                                   # Windows: builds the dashboard on first run, then starts it
python run.py --statements "G:\My Drive\Finance\statements"
python tools/snapshot_to_db.py "G:\My Drive\Finance\statements\finance-snapshot.fmsnap"   # web data → data/finance.db
```

## Where this code came from

The original project folder was lost with a laptop. The only surviving copy was the phone app deployed on
Vercel (`finance-master-phone`), saved as built in `recovered/phone-dist/`.

- `backend/` is byte-for-byte what was deployed (the build bundles every `.py` file as text;
  `tools/extract_backend.py` decodes them). Later commits add the statements-folder option and what the
  web app needs.
- `frontend/src/` was rebuilt from the minified bundle (see `tools/frontend-recovery/unbundle.mjs`). Every
  page was checked against the original bundle on the same data and renders the same text. Names of
  components, props and API fields are real; short local variable names inside functions (`e`, `t`, `n`…)
  are left over from minification.
- Not recovered: tests, and anything else that was never deployed.
