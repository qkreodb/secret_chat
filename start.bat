@echo off
rem Secret LAN Chat 실행 런처 (Node PATH 설정 없이도 동작)
cd /d "%~dp0"
".\node_modules\electron\dist\electron.exe" .
