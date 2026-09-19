@echo off
chcp 65001 >nul
rem Xingce Knowledge Station - one-command publish to GitHub Pages
rem Usage:  publish.cmd            diff -> publish -> wait build -> verify
rem         publish.cmd --check    show diff only
rem         publish.cmd -m "msg"   custom commit message
rem
rem Token resolution order:
rem   1) GH_TOKEN environment variable
rem   2) gh auth token (gh login state)
rem   3) ..\.gh_token file (one line)  <- used when gh cannot store credentials
if not defined GH_TOKEN (
  for /f "usebackq delims=" %%T in (`gh auth token 2^>nul`) do set "GH_TOKEN=%%T"
)
if not defined GH_TOKEN (
  if exist "%~dp0..\.gh_token" set /p GH_TOKEN=<"%~dp0..\.gh_token"
)
if not defined GH_TOKEN (
  echo [!] No GitHub token found. Do one of these and retry:
  echo     1^) gh auth login
  echo     2^) set the GH_TOKEN environment variable
  echo     3^) put the token into "%~dp0..\.gh_token"
  exit /b 2
)
python "%~dp0scripts\publish.py" %*
