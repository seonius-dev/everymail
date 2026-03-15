#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/opt/self-mail"
REPO_URL="${1:-}"
BRANCH="${2:-main}"

if [[ "$EUID" -ne 0 ]]; then
  echo "Bu script root olarak çalışmalı: sudo bash scripts/quickstart.sh <repo_url>"
  exit 1
fi

if [[ -z "$REPO_URL" ]]; then
  echo "Kullanım: sudo bash scripts/quickstart.sh https://github.com/<user>/<repo>.git [branch]"
  exit 1
fi

echo "[1/4] Paketler kuruluyor..."
apt update
apt install -y git curl ca-certificates

echo "[2/4] Repo hazırlanıyor..."
rm -rf "$PROJECT_DIR"
git clone --branch "$BRANCH" "$REPO_URL" "$PROJECT_DIR"
cd "$PROJECT_DIR"
chmod +x scripts/install-vps.sh
chmod +x scripts/quickstart.sh

echo "[3/4] Ana kurulum başlatılıyor..."
shift 2 || true

if [[ -t 0 ]]; then
  bash scripts/install-vps.sh "$@"
elif [[ -r /dev/tty ]]; then
  # curl | bash kullanımında stdin pipe olur; interaktif sorular için terminale bağlan.
  bash scripts/install-vps.sh "$@" </dev/tty
else
  # TTY yoksa install-vps.sh gerekli değerleri env veya argümanlardan okur.
  bash scripts/install-vps.sh "$@"
fi

echo "[4/4] Tamamlandı."
