# HƯỚNG DẪN TÍCH HỢP HI-RES VAULT COMPANION VÀO NAVIDROME (LXC)

Tài liệu này hướng dẫn cách kết nối và vận hành **Hi-Res Vault Companion** song song với máy chủ nghe nhạc **Navidrome** đang chạy trong LXC Container trên Proxmox / Home Server.

---

## 1. Cơ Chế Hoạt Động & Tích Hợp Kỹ Thuật

```
[Người Dùng] 
     │
     ├──► Web UI Navidrome (Port 4533): Nghe nhạc, xem Playlist, Stream
     │          ▲
     │          │ (Subsonic API: Ping, Trigger Scan, Đọc Tag Comment)
     │          ▼
     └──► Web UI Hi-Res Companion (Port 5050): Kiểm tra Fake Hi-Res, Spectrogram, Phân Loại
                │
                ▼ (Đọc & Ghi Tag Âm Thanh)
      [Kho Nhạc Chung: /mnt/vault/GleVault/Hires]
```

### Hai trục tích hợp chính:
1. **Trục Dữ Liệu (Metadata Tagging)**:
   - App phân tích dải tần số thực tế bằng FFT.
   - Ghi trực tiếp tag chuẩn vào file âm thanh:
     - `COMMENT = "[True Hi-Res 24bit/96kHz - Verified]"`
     - `COMMENT = "[Fake Hi-Res - Upsampled from CD 44.1k]"`
     - `COMMENT = "[Studio Master 24bit - Verified]"`
   - Navidrome tự động đọc trường `Comment` này vào cơ sở dữ liệu `navidrome.db`.
2. **Trục Điều Khiển (Subsonic REST API)**:
   - Sau khi bạn phân loại, đổi tên hoặc gắn tag mới, App sẽ tự động gọi API Subsonic `/rest/startScan.view` của Navidrome.
   - Navidrome tự động cập nhật thư viện ngay lập tức mà bạn không cần phải vào giao diện Navidrome bấm quét lại.

---

## 2. Cách Tạo Smart Playlist Phân Loại Nhạc Trong Navidrome

Sau khi App đã gắn tag chất lượng cho kho nhạc, bạn có thể tạo các danh sách phát thông minh (Smart Playlist) cực kỳ tiện lợi ngay trong Navidrome:

### 1. Danh sách phát "💎 Nhạc Hi-Res Thật (True Hi-Res)":
- Tạo tệp `True_HiRes.nsp` đặt vào thư mục nhạc hoặc tạo trên Web UI Navidrome:
```json
{
  "all": [
    {"comment": {"contains": "[True Hi-Res]"}}
  ],
  "sort": "artist",
  "order": "asc"
}
```

### 2. Danh sách phát "⚠️ Nhạc Fake Hi-Res Cần Tránh":
```json
{
  "all": [
    {"comment": {"contains": "[Fake Hi-Res]"}}
  ],
  "sort": "artist",
  "order": "asc"
}
```

### 3. Danh sách phát "🎙️ Studio Master 24-Bit":
```json
{
  "all": [
    {"comment": {"contains": "[Studio Master]"}}
  ],
  "sort": "artist",
  "order": "asc"
}
```

---

## 3. Cách Triển Khai Chạy Tự Động Trong LXC Navidrome

### Cách 1: Chạy Dưới Dạng Systemd Service Trong LXC (Khuyên dùng)
Nếu thư mục nhạc `/mnt/vault/GleVault/Hires` đã được bind-mount vào LXC container (ví dụ tại `/music`):

1. Tạo file service `/etc/systemd/system/hires-vault.service` bên trong LXC container:
```ini
[Unit]
Description=Hi-Res Vault Companion for Navidrome
After=network.target navidrome.service

[Service]
Type=simple
User=root
WorkingDirectory=/music/tools
ExecStart=/usr/bin/bash /music/tools/start.sh
Restart=always
RestartSec=5
Environment=PORT=5050
Environment=HOST=0.0.0.0

[Install]
WantedBy=multi-user.target
```

2. Bật và khởi động service:
```bash
systemctl daemon-reload
systemctl enable --now hires-vault.service
```

3. Truy cập Web Dashboard tại: `http://<IP-LXC>:5050`.

---

### Cách 2: Chạy Trực Tiếp Bằng Lệnh Khởi Động
Tại thư mục chứa nhạc, bạn chỉ cần gõ:
```bash
./tools/start.sh
```
Hệ thống sẽ tự động dùng `uv run` tải các thư viện cần thiết (`fastapi`, `uvicorn`, `numpy`, `scipy`, `mutagen`) trong môi trường cách ly và mở cổng `5050`.

---

## 4. Cấu Hình Kết Nối Trên Giao Diện Web App

1. Mở trình duyệt vào `http://localhost:5050` (hoặc `http://<IP-LXC>:5050`).
2. Chuyển sang tab **"Tích Hợp Navidrome"**.
3. Điền thông tin:
   - **Navidrome URL**: Ví dụ `http://localhost:4533` (nếu chạy cùng container) hoặc `http://192.168.1.xxx:4533`.
   - **Tài khoản & Mật khẩu**: Tài khoản quản trị Navidrome của bạn.
4. Bấm **"Kiểm Tra Kết Nối (Ping)"**: Khi hiện đèn xanh `🟢 Đã kết nối`, hệ thống đã sẵn sàng điều khiển Navidrome!
