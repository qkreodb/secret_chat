#!/bin/bash
# Secret LAN Chat 실행 런처
cd "$(dirname "$0")"

ELECTRON="./node_modules/electron/dist/electron"

if [ ! -f "$ELECTRON" ]; then
  echo "node_modules가 없습니다. npm install을 먼저 실행하세요."
  read -p "지금 설치할까요? (y/N): " answer
  if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    npm install
  else
    exit 1
  fi
fi

"$ELECTRON" .
