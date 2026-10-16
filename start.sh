#!/usr/bin/env bash
# Khởi động Hi-Res Vault Companion Web App
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export HIRES_VAULT_DIR="${HIRES_VAULT_DIR:-/mnt/vault/GleVault/Hires}"
export PORT="${PORT:-5050}"
export HOST="${HOST:-127.0.0.1}"

echo "======================================================================"
echo "    KHỞI ĐỘNG HI-RES VAULT COMPANION CHO NAVIDROME"
echo "    Thư mục kho nhạc: $HIRES_VAULT_DIR"
echo "    Địa chỉ Web App:  http://$HOST:$PORT"
echo "======================================================================"

if command -v uv >/dev/null 2>&1; then
    echo "⚡ Sử dụng uv run (tự động nạp requirements / pyproject.toml)..."
    exec uv run python3 app.py
else
    echo "🐍 Sử dụng python3..."
    exec python3 app.py
fi
