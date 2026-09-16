@echo off
chcp 65001 >nul
rem Xingce Knowledge Station - one-command publish to GitHub Pages
rem Usage:  publish.cmd            diff -> publish -> wait build -> verify
rem         publish.cmd --check    show diff only
rem         publish.cmd -m "msg"   custom commit message
python "%~dp0scripts\publish.py" %*
