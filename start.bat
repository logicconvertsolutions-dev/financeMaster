@echo off
title Finance Master
cd /d "%~dp0"
if not exist frontend\dist\index.html (
  echo Building the dashboard, first run only...
  pushd frontend
  call npm install
  call npm run build
  popd
)
rem To read statements from Google Drive, add e.g.:  --statements "G:\My Drive\Finance\statements"
python run.py %*
pause
