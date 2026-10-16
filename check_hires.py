#!/usr/bin/env python3
"""
Công cụ CLI kiểm tra chất lượng nhạc Hi-Res / Lossless.
Sử dụng engine bằng chứng từ core.audio_scoring; phổ không xác lập nguồn master.

Cách dùng:
    python3 check_hires.py "tên_bài_hát.flac"
    python3 check_hires.py ./thu_muc_nhac/
"""

import sys
from pathlib import Path

# Đảm bảo import được module core từ thư mục gốc
ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from core.analyzer import analyze_audio_file

AUDIO_EXTENSIONS = {'.flac', '.wav', '.dsf', '.dff', '.m4a', '.mp3', '.ape', '.ogg', '.opus', '.wma'}

def print_help():
    print("""
========================================================================
     KIỂM TRA TÍNH NHẤT QUÁN KỸ THUẬT ÂM THANH
========================================================================
Cách sử dụng:
  uv run python3 check_hires.py <file_hoặc_thư_mục>
  hoặc:
  python3 check_hires.py <file_hoặc_thư_mục>

Ví dụ:
  python3 check_hires.py "04 Video Games.flac"
  python3 check_hires.py "./NewJeans/"
========================================================================
""")

def check_single_file(filepath: Path):
    if not filepath.is_file():
        return

    print(f"\n📂 File: {filepath.name}")
    try:
        res = analyze_audio_file(str(filepath))
        sr = res.get('sample_rate', 44100)
        bits = res.get('bit_depth', 16)
        codec = res.get('codec', filepath.suffix.lstrip('.')).upper()
        cutoff = res.get('cutoff_hz')
        drop = res.get('cutoff_drop_db', 0.0)

        print(f"   Thông số: {codec} | {bits}-bit / {sr/1000:.1f} kHz")
        if cutoff and cutoff < (sr // 2):
            print(f"   Biên phổ (sàng lọc): {cutoff:,} Hz (Sụt {drop} dB)")
        authenticity = res['authenticity']
        score = f"{authenticity['score']}/100" if authenticity['score'] is not None else 'N/A'
        print(f"   Authenticity & Integrity: {score} | Coverage: {authenticity['coverage']:.1%}")
        print(f"   Kết quả: {res.get('badge', res.get('verdict'))}")
        print(f"   Chi tiết: {res.get('explanation')}")
    except Exception as e:
        print(f"   ❌ Lỗi phân tích: {e}")

def main():
    if len(sys.argv) < 2:
        print_help()
        sys.exit(0)

    target = Path(sys.argv[1])
    if not target.exists():
        print(f"Lỗi: Không tìm thấy '{target}'")
        sys.exit(1)

    if target.is_file():
        check_single_file(target)
    elif target.is_dir():
        files = [f for f in target.rglob('*') if f.is_file() and f.suffix.lower() in AUDIO_EXTENSIONS]
        print(f"Tìm thấy {len(files)} file âm thanh trong '{target.name}'. Bắt đầu kiểm tra...")
        for f in sorted(files):
            check_single_file(f)

if __name__ == '__main__':
    main()
