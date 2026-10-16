# Hi-Res Vault Companion & Audiophile 7-Pillar Studio

Công cụ kiểm tra tính nhất quán kỹ thuật của thư viện nhạc, đo tín hiệu, ReplayGain, Gapless và phân nhóm định dạng cho Navidrome/Plex/Subsonic. Không xác minh nguồn master chỉ từ phổ và không coi Hi-Res là bảo đảm chất lượng nghe.

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
- `numpy`: FFT và thống kê PCM; DR estimate theo block 3 giây, không coi là TT DR được chứng nhận.
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

## Audio Authenticity & Integrity

Mở tab **Kiểm Định 7 Chuẩn**. Phần đầu là điểm authenticity, confidence,
coverage, cảnh báo toàn vẹn, kỳ vọng so với header và phép đo. Chọn bài ở ô Lab,
chọn các bài ở bảng Kho Nhạc, hoặc nhập thư mục trong kho để quét đệ quy.
Các card cũ và thao tác playback, ReplayGain, gapless, fingerprint và phân tầng
vẫn có, tách khỏi điểm. Ghi tag và quản lý file vẫn là thao tác riêng do bạn chọn.

- FAST: sàng lọc 20 giây đầu, luôn sơ bộ và không hiện điểm số chính thức.
- BALANCED: mặc định; giải mã toàn file, kiểm tra FLAC và đo nhiều cửa sổ.
- DEEP: nhiều cửa sổ hơn và flaccheck `max` khi có.
- Hàng đợi nền, concurrency 1–4, hủy, lưu tiến độ/kết quả SQLite, tải JSON/JSONL/CSV.
- Kỳ vọng codec/container/sample rate/bit depth/lossless, nguồn/bản phát hành và
  tệp tham chiếu đều tùy chọn. Đường dẫn phải trong kho nhạc.
- Cache theo SHA-256 nội dung, rules/config, detector/engine, mode và tham chiếu.
  Khởi động lại giữ kết quả đã xong; job dở được ghi INTERRUPTED để quét lại.
- Missing checksum khác checksum sai. Padding yêu cầu bit thấp **luôn** bằng 0
  qua toàn file từng kênh, đủ mẫu không im lặng. Dither không chứng minh native 24-bit.
- Cutoff phổ hoặc thiếu siêu âm chỉ yêu cầu REVIEW; không tự kết luận MP3/AAC,
  bitrate hay upsampling. Các detector lịch sử nguồn hiện chưa được phép trừ điểm.
- Điểm 100 có thể chỉ bao phủ 61.5% trọng số áp dụng. Xem coverage và các rule chưa
  kết luận; nhiều tệp Hi-Res sẽ có N/A. Lỗi toàn vẹn luôn hiện độc lập với điểm.

FFmpeg/ffprobe và `flac` là công cụ chính, đã kiểm thử bằng FFmpeg 8.0 / FLAC 1.5.0
trên Linux. flaccheck 0.1.2 là **tùy chọn, thử nghiệm**, gọi riêng qua PATH; xem
[dependency review](docs/audio-detectors.md) để kiểm tra license, checksum và
false positives trước khi cài. Không tải audio lên dịch vụ bên ngoài.

Dùng một worker ứng dụng. `HIRES_VAULT_DIR` xác định ranh giới kho nhạc;
`AUDIO_TOOLS_CACHE_DIR` đổi vị trí cache (mặc định `./cache`). Ví dụ:

```bash
HIRES_VAULT_DIR="/path/to/Music" ./start.sh

# Phân tích trực tiếp bằng Python, không qua UI:
uv run python - <<'PYTHON'
import json
from core.audio_scoring import analyze
result = analyze("/path/to/Music/track.flac", mode="BALANCED")
print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
PYTHON

# Tạo job quét thư mục; chuỗi folder rỗng = toàn bộ kho:
curl -X POST http://localhost:5050/api/scoring/jobs \
  -H 'Content-Type: application/json' \
  -d '{"folder":"","mode":"BALANCED","concurrency":2}'
# GET /api/scoring/jobs/{job_id}, /results?offset=0&limit=50
# POST /api/scoring/jobs/{job_id}/cancel
# GET /api/scoring/jobs/{job_id}/export?format=json|jsonl|csv
```

Chi tiết: [phương pháp/giới hạn](docs/audio-scoring-methodology.md),
[detector và dependency](docs/audio-detectors.md),
[kết quả test thực tế](docs/audio-test-results.md),
[JSON đo thật](docs/examples/).

Kiểm thử tái lập (chỉ tạo audio tổng hợp trong thư mục tạm):

```bash
uv run pytest -q
uv run python -m tests.calibrate_audio /tmp/audio-fixtures /tmp/audio-results
# Playwright dùng Chromium hệ thống; không cần tải browser bundle:
uv run --extra browser python tests/browser_audio.py /tmp/audio-fixtures /tmp/audio-browser
```

Playwright chỉ thuộc extra `browser`, không cài cùng runtime hoặc bộ test Python.
BALANCED không chạy flaccheck để tránh thêm một lượt decode/toàn bộ buffer thử nghiệm.

Danh sách bài hát được quét từ vault hiện tại. Dashboard dùng kết quả kiểm định còn khớp engine, rule và file; nhóm CD/lossy có thể phân loại từ metadata khi chưa kiểm định, với chú thích ở nhãn bài hát. Bài chưa xác định không được gán số liệu chất lượng mẫu.

CLI tổ chức thư viện dùng chung nhật ký `.vault_tiering_rollback.json` với Vault Tiering; khôi phục bằng `python organize_library.py --rollback /path/to/vault`. Khi có xung đột, file đích được giữ nguyên và mục rollback lỗi được giữ lại để thử lại.
