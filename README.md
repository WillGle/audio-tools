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
- [`MediaFile`](https://github.com/beetbox/mediafile): Thống nhất ghi tag giữa các định dạng; Mutagen giữ dữ liệu tag gốc cho hoàn tác.
- `numpy`: Xử lý tín hiệu số DSP (FFT, Entropy)
- [`dr14meter`](https://github.com/pe7ro/dr14meter): Tính Dynamic Range; khi đo lỗi, trả trạng thái không đo được thay vì dùng peak−RMS thay thế.
- `pydantic`: Kiểm thực dữ liệu API

### 2. Tiện ích hệ thống (System Dependencies)
Cần có sẵn các công cụ dòng lệnh:
- **`ffmpeg` / `ffprobe`**: Dùng để giải mã luồng audio, đo EBU R128 LUFS và render Spectrogram.
- **`flac`**: Dùng để đối chiếu Audio MD5 và kiểm tra frame CRC (`flac -t`).
- **[`rsgain` >= 3.6](https://github.com/complexlogic/rsgain)**: Đo ReplayGain 2.0 và True Peak ở chế độ chỉ đọc; MediaFile ghi các giá trị này khi chọn gắn tag. FFmpeg vẫn đo LUFS/LRA và xử lý DSF/DFF để tương thích với rsgain 3.6 chưa hỗ trợ DSD.
- **`fpcalc` (Chromaprint)**: Tạo fingerprint âm học. Đây là tiện ích hệ thống, không phải gói Python `chromaprint`.

Trên NixOS, có thể chạy với các tiện ích trong môi trường tạm:

```bash
nix-shell -p ffmpeg flac chromaprint rsgain --run './start.sh'
```

Các công cụ phải có trong `PATH` của tiến trình chạy ứng dụng. Thiếu rsgain hoặc đo lỗi sẽ báo lỗi, không ghi ReplayGain mặc định. Tag `R128_TRACK_GAIN` được lưu dưới dạng số nguyên Q7.8 qua MediaFile.

Sao lưu mới giữ nguyên các tag bị thay đổi, gồm nhiều giá trị, ngôn ngữ ID3 và dữ liệu MP4. Sao lưu cũ vẫn đọc được, nhưng chỉ khôi phục thông tin đã lưu trước đây (ví dụ, bản cũ không lưu ngôn ngữ của comment ID3).

---

## 🚀 Khởi Động Web App

```bash
# Khởi động dịch vụ trên cổng 5050:
./start.sh
```

Truy cập giao diện Web tại: **`http://localhost:5050`**. Mặc định chỉ lắng nghe trên máy cục bộ; `HOST` và `PORT` có thể cấu hình khi chạy `start.sh`. Ứng dụng chưa có đăng nhập; chỉ mở ra mạng tin cậy hoặc qua proxy có xác thực.

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
   - Hỗ trợ chế độ **Symlink** (không chuyển file gốc, từ chối ghi đè đích đã tồn tại) và **Move** (kèm file rollback).

Danh sách bài hát được quét từ vault hiện tại. Dashboard chỉ đếm kết quả kiểm định đã lưu; bài chưa kiểm định không được gán số liệu chất lượng mẫu.

CLI tổ chức thư viện dùng chung nhật ký `.vault_tiering_rollback.json` với Vault Tiering; khôi phục bằng `python organize_library.py --rollback /path/to/vault`. Khi có xung đột, file đích được giữ nguyên và mục rollback lỗi được giữ lại để thử lại.
