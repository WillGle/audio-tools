# Audio Management & Hi-Res Quality Tools

Thư mục chứa toàn bộ mã nguồn các công cụ kiểm định chất lượng âm thanh và chuẩn hóa thư viện nhạc.

---

## 1. Công cụ kiểm định Hi-Res: `check_hires.py`
Phân tích phổ tần số (DSP FFT) và dải động để phát hiện file Hi-Res thật (True Hi-Res) hay nhạc bị upsample/upsize giả mạo từ CD/MP3.

### Cách sử dụng:
```bash
# Kiểm tra 1 bài hát cụ thể:
uv run --with numpy,scipy python3 tools/check_hires.py "04 Video Games.flac"

# Kiểm tra toàn bộ một album / thư mục:
uv run --with numpy,scipy python3 tools/check_hires.py "./NewJeans/"
```

### Các trạng thái trả về:
- 🟢 **TRUE HI-RES**: Sóng hài siêu âm mở rộng tự nhiên vượt 24kHz - 40kHz+
- 🟢 **TRUE DSD**: File âm thanh 1-bit nguyên bản từ SACD
- 🟡 **STUDIO MASTER 24-BIT**: Chuẩn 24-bit phòng thu thật (44.1kHz hoặc 48kHz)
- 🔵 **CD LOSSLESS**: File 16-bit / 44.1kHz chuẩn CD Red Book
- 🔴 **FAKE HI-RES**: Gắn mác 96k/192k nhưng bị cắt cụt ở 22.05kHz (upsample từ CD)
- 🔴 **FAKE LOSSLESS**: Đuôi FLAC nhưng dải tần bị cắt cụt dưới 18kHz (convert từ MP3)
- ⚪ **LOSSY**: Nhạc nén MP3 / AAC

---

## 2. Công cụ phân loại thư viện: `organize_library.py`
Tự động đọc metadata ID3, phục hồi tên cho các file số vô danh, gom các album bị phân tán và phân tầng thành 3 cấp:
- `01_Hi-Res & DSD/`
- `02_Lossless_CD/`
- `03_Lossy_MP3_AAC/`

### Cách sử dụng:
```bash
# Chế độ mô phỏng an toàn (Dry-Run, không chạm vào file):
uv run --with mutagen python3 tools/organize_library.py --dry-run

# Chế độ thực thi di chuyển và sắp xếp chính thức:
uv run --with mutagen python3 tools/organize_library.py --execute
```

### Khôi phục (Rollback):
Khi chạy `--execute`, toàn bộ lịch sử di chuyển được lưu tại `tools/organize_rollback.json` để có thể hoàn tác bất kỳ lúc nào nếu cần.
