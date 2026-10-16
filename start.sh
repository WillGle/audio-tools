#!/usr/bin/env bash
# Khởi động Hi-Res Vault Companion Web App
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export HIRES_VAULT_DIR="${HIRES_VAULT_DIR:-/mnt/vault/GleVault/Hires}"
PORT="${PORT:-5050}"
HOST="${HOST:-0.0.0.0}"

echo "======================================================================"
echo "    KHỞI ĐỘNG HI-RES VAULT COMPANION CHO NAVIDROME"
echo "    Thư mục kho nhạc: $HIRES_VAULT_DIR"
echo "    Địa chỉ Web App:  http://$HOST:$PORT"
echo "======================================================================"

# Tự động giải phóng nếu tiến trình cũ hoặc cổng đang chiếm dụng
PORT_PID=$(ss -lptn "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -n1 || true)
if [ -z "$PORT_PID" ] && command -v lsof >/dev/null 2>&1; then
    PORT_PID=$(lsof -ti :$PORT 2>/dev/null | head -n1 || true)
fi

if [ -n "$PORT_PID" ]; then
    echo "⚠️  Phát hiện cổng $PORT đang bị chiếm (PID: $PORT_PID). Đang giải phóng..."
    kill -9 $PORT_PID 2>/dev/null || true
    sleep 0.5
fi
pkill -f "app.py" 2>/dev/null || true

if command -v uv >/dev/null 2>&1; then
    echo "⚡ Sử dụng uv run (tự động nạp requirements / pyproject.toml)..."
    exec uv run python3 app.py
else
    echo "🐍 Sử dụng python3..."
    exec python3 app.py
fi
