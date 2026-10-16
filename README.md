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

## Duyệt và sắp xếp kho nhạc local

Ở tab **Sắp xếp**, nhập thư mục tải mới (tương đối trong kho,
ví dụ `Downloads`), hoặc để trống để quét toàn bộ. Bấm **Đọc metadata & xem trước**.
Ứng dụng đọc tag trong cả thư mục con và đề xuất
`Nghệ sĩ / Album / Số bài - Tên bài.ext`, ưu tiên album artist để gom album.
Ô **Mẫu tên file** cho phép sửa công thức, mặc định `{track} - {title}`; ví dụ
`{artist} - {title}` hoặc `{title}`. Hỗ trợ thêm `{album}`, `{disc}`; không thêm
đuôi file hoặc dấu phân cách thư mục. `{title}` là bắt buộc. Số bài/đĩa có hai
chữ số; tag thiếu để trống. Đĩa từ 2 trở lên tự thêm `D02 - ` nếu mẫu chưa có `{disc}`.
Đổi mẫu cần xem trước lại. Tên cũ/mới được tách khỏi thư mục và tô phần khác biệt;
nhãn riêng cho biết chỉ đổi tên, chuyển thư mục hay giữ nguyên.
Lọc nhóm sẵn sàng, thiếu metadata, trùng đích hoặc đã đúng vị trí để kiểm tra.
Danh sách dạng bảng so sánh tên cũ/mới và thư mục tương ứng ngay bên dưới,
cuộn đến hết kết quả trong khung với tiêu đề cột cố định, không phân trang.
Tìm theo tên cũ/mới, nghệ sĩ, album hoặc thư mục; lọc bài có đổi tên hoặc chỉ
chuyển thư mục. Mở **Chi tiết** để xem metadata. Bấm **Sửa tên** ngay cạnh tên đề xuất để chỉnh
riêng từng bài, rồi **Lưu tên** hoặc **Hủy**. Giữ nguyên đuôi file; hệ thống kiểm
tra lại trùng tên sau khi lưu. Chỉ bản xem trước thay đổi, chưa đổi tên file thật.
Đọc metadata lại sẽ tạo đề xuất mới và bỏ các chỉnh sửa thủ công. Nút áp dụng xử lý mọi bài sẵn sàng trong bản xem trước,
kể cả các bài ngoài nhóm đang lọc.

**Áp dụng đổi tên & di chuyển** yêu cầu xác nhận bản xem trước. Chỉ các bài sẵn
sàng được chuyển; không ghi đè, sửa tag hoặc mã hóa lại audio. Thiếu tên/nghệ sĩ
thì giữ nguyên, không suy đoán từ tên ngẫu nhiên; thiếu album dùng `Chưa rõ album`.
Mở **Hoàn tác sắp xếp** để khôi phục vị trí các lần sắp xếp metadata đã áp dụng.
Nhật ký `.metadata_organize_rollback.json` tách riêng khỏi phân cấp chất lượng.
Không xóa thư mục rỗng, không di chuyển ảnh bìa/CUE hay các tệp phụ.
Nếu file thay đổi sau khi xem trước, cần tạo lại bản xem trước.

Tìm theo tên bài, nghệ sĩ, album hoặc đường dẫn trong bảng Kho nhạc; dùng bộ lọc
cột và sắp xếp theo nghệ sĩ/album để duyệt mà không cần di chuyển file.

## Audio Authenticity & Integrity

Mở tab **Kiểm tra âm thanh**, chọn phạm vi (một bài, các bài đã chọn hoặc thư mục),
chọn chế độ rồi bấm **Bắt đầu kiểm tra**. Có thể tìm bài bằng tên và chọn bằng
phím mũi tên/Enter, hoặc chọn nhiều bài ở Kho Nhạc rồi bấm nút kiểm tra.
Kết quả hiển thị điểm authenticity, confidence, coverage, cảnh báo toàn vẹn và
đối chiếu khai báo với phép đo. Chọn **Chi tiết** trong bảng để xem từng bài;
mở thẻ chẩn đoán để đọc bằng chứng và số liệu. Có thể hủy hoặc xem lại lượt quét.
Thiết lập tự thu gọn khi bắt đầu quét và có thể mở lại. Khi quét nhiều bài,
chọn **Chi tiết** để mở kết quả từng bài; bảng đối chiếu thông số và menu xuất
kết quả được thu gọn để ưu tiên tiến độ và danh sách.
Các kiểm tra playback, ReplayGain, gapless, fingerprint và phân tầng nằm trong
phần chẩn đoán bổ sung, tách khỏi điểm. Ghi tag và quản lý file vẫn là thao tác riêng.

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
