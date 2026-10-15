@echo off
rem Opens the pbx menu. Double-click this file. Runs from this folder, whatever the current folder is.
cd /d "%~dp0"
node pbx.mjs menu
echo.
pause
