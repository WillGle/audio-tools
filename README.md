# Hi-Res Vault Companion & Audiophile 7-Pillar Studio

Bộ công cụ kiểm định chất lượng âm thanh chuyên sâu cho dân Audiophile, tự động phát hiện nhạc giả mạo, đo Dynamic Range (DR), ReplayGain 2.0, Gapless và phân tầng kho nhạc 3 cấp cho Navidrome/Plex/Subsonic.

---

## 📦 Yêu Cầu & Cài Đặt (Requirements)

### 1. Thư viện Python
Có thể cài đặt qua `pip` hoặc chạy trực tiếp bằng `uv`:

```bash
# Cài đặt qua pip tiêu chuẩn:
pip install -r requirements.txt

# Hoặc cài đặt kèm môi trường phát triển / kiểm thử:
pip install -r requirements-dev.txt

# Nếu sử dụng uv (cực nhanh, tự động nạp pyproject.toml):
uv run python3 app.py
```

Các gói phụ thuộc chính:
- `fastapi` & `uvicorn[standard]`: REST API & Web Server
- `mutagen`: Trích xuất và ghi Metadata (FLAC, MP3 ID3, M4A, DSF)
- `numpy` & `scipy`: Xử lý tín hiệu số DSP (FFT, Crest factor, Entropy)
- `pydantic`: Kiểm thực dữ liệu API

### 2. Tiện ích hệ thống (System Dependencies)
Cần có sẵn các công cụ dòng lệnh:
- **`ffmpeg` / `ffprobe`**: Dùng để giải mã luồng audio, đo EBU R128 LUFS và render Spectrogram.
- **`flac`**: Dùng để đối chiếu Audio MD5 và kiểm tra frame CRC (`flac -t`).

---

## 🚀 Khởi Động Web App

```bash
# Khởi động dịch vụ trên cổng 5050:
./start.sh
```

Truy cập giao diện Web tại: **`http://localhost:5050`** (hoặc `http://<IP-Server>:5050`).

---

## 🎧 7 Tính Năng Audiophile "Sát Sườn"

1. **Đo lường Dynamic Range (DR Meter / TT DR Standard)**:
   - Chấm điểm **DR1 đến DR20** (tương thích `dr.loudness-war.info`).
   - Phân biệt `DR14 (Wide Dynamic Range)` vs `DR5 (Heavily Compressed / Brickwalled)`.
2. **Kiểm tra tính toàn vẹn Bit-Perfect & Phát hiện Bit-Rot**:
   - Đối chiếu **Audio MD5 Header** trong `STREAMINFO` của FLAC và rà soát lỗi frame CRC-16.
3. **Phát hiện tệp "24-bit Giả" (Bit Padding)**:
   - Phân tích histogram entropy của 8 bit thấp nhất (LSB). Nếu LSB = 0 $\rightarrow$ `Fake 24-bit (16-bit Padded)`.
4. **Phân định chuẩn DSD / SACD Purity**:
   - Phân tích dải tần siêu âm >30kHz để nhận diện tiếng ồn lượng tử **Sigma-Delta Noise Shaping** của DSD thật.
   - Nhận diện cấu hình: **Stereo 2.0** vs **Multi-channel 5.1 Surround**.
5. **ReplayGain 2.0 & EBU R128**:
   - Đo Integrated LUFS (-18 LUFS standard), True Peak dBTP, Loudness Range (LRA).
   - 1-click ghi tag vào metadata để Navidrome và DAC tự cân bằng âm lượng mà bit nhạc gốc nguyên vẹn 100%.
6. **Kiểm tra Gapless Playback & Seamless Transitions**:
   - Đo khoảng lặng đầu/đuôi và mẫu năng lượng biên (> -45 dBFS) của các album Live/Mix.
7. **Tự động xuất Cấu trúc Kho Nhạc 3 Cấp (Vault Tiering)**:
   - `01_DSD & Hi-Res (>24/96k)`
   - `02_Lossless CD (16/44.1k)`
   - `03_Quarantine (Fake Hi-Res, MP3, File Lỗi)`
   - Hỗ trợ chế độ **Symlink** (an toàn 100%, không chuyển file gốc) và **Move** (kèm file rollback).
