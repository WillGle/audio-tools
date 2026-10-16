#!/usr/bin/env python3
"""
Công cụ kiểm tra nhạc Hi-Res thật (True Hi-Res) vs Nhạc bị Upsize / Upsampled (Fake Hi-Res).
Yêu cầu: ffmpeg, ffprobe, python3 (hỗ trợ numpy/scipy nếu có uv run hoặc pip).
Cách dùng:
    python3 check_hires.py "tên_bài_hát.flac"
    python3 check_hires.py ./thu_muc_nhac/
"""

import sys
import os
import json
import subprocess
from pathlib import Path

def print_help():
    print("""
========================================================================
     CÔNG CỤ KIỂM TRA CHUẨN HI-RES vs NHẠC UPSIZE (UPSAMPLED)
========================================================================
Cách sử dụng:
  uv run --with numpy,scipy python3 tools/check_hires.py <file_hoặc_thư_mục>
  hoặc:
  python3 tools/check_hires.py <file_hoặc_thư_mục>

Ví dụ:
  uv run --with numpy,scipy python3 tools/check_hires.py "04 Video Games.flac"
  uv run --with numpy,scipy python3 tools/check_hires.py "./NewJeans/"
========================================================================
""")

def check_single_file(filepath):
    p = Path(filepath)
    if not p.is_file():
        return
        
    ext = p.suffix.lower()
    if ext in ('.mp3', '.m4a', '.aac', '.ogg', '.wma'):
        # Check codec
        p_c = subprocess.run([
            'ffprobe', '-v', 'error', '-select_streams', 'a:0',
            '-show_entries', 'stream=codec_name,sample_rate,bit_rate',
            '-of', 'json', str(p)
        ], capture_output=True, text=True)
        try:
            d_c = json.loads(p_c.stdout)
            st = d_c['streams'][0]
            codec = st.get('codec_name', ext[1:])
            sr = st.get('sample_rate', '44100')
            br = int(st.get('bit_rate', 0)) // 1000
        except Exception:
            codec = ext[1:]
            sr = '44100'
            br = 0
        
        print(f"\n📂 File: {p.name}")
        print(f"   Định dạng: {codec.upper()} ({sr} Hz, ~{br} kbps)")
        print(f"   Kết luận: ⚪ LOSSY (Nhạc nén tổn hao - KHÔNG PHẢI Hi-Res)")
        print(f"   Giải thích: MP3/AAC là định dạng nén mất dữ liệu, bị cắt tần số từ 16kHz - 20kHz.")
        return

    # Check ffprobe JSON
    cmd_info = [
        'ffprobe', '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,sample_rate,bits_per_raw_sample,bits_per_sample,channels,duration',
        '-of', 'json', str(p)
    ]
    p_info = subprocess.run(cmd_info, capture_output=True, text=True)
    codec = ext.lstrip('.')
    orig_sr = 44100
    orig_bits = 16
    dur = 180.0
    try:
        j_data = json.loads(p_info.stdout)
        if 'streams' in j_data and len(j_data['streams']) > 0:
            st = j_data['streams'][0]
            codec = st.get('codec_name', codec)
            if st.get('sample_rate'):
                orig_sr = int(st['sample_rate'])
            raw_b = st.get('bits_per_raw_sample')
            std_b = st.get('bits_per_sample')
            if raw_b and int(raw_b) > 0:
                orig_bits = int(raw_b)
            elif std_b and int(std_b) > 0:
                orig_bits = int(std_b)
            if st.get('duration'):
                dur = float(st['duration'])
    except Exception:
        pass

    print(f"\n📂 File: {p.name}")
    print(f"   Thông số file: {codec.upper()} | {orig_bits}-bit / {orig_sr/1000:.1f} kHz")

    if 'dsd' in codec.lower() or ext in ('.dsf', '.dff'):
        print(f"   Kết luận: 🟢 TRUE DSD (Direct Stream Digital / SACD Native)")
        print(f"   Giải thích: Tín hiệu âm thanh 1-bit siêu cao tần nguyên bản.")
        return

    # Run DSP check with ffmpeg and numpy
    try:
        import numpy as np
    except ImportError:
        print("   ⚠️  Cần thư viện numpy để phân tích phổ âm thanh sâu hơn.")
        print("   Vui lòng chạy bằng lệnh: uv run --with numpy,scipy python3 check_hires.py <file>")
        return

    # Multi-slice FFT sampling (bắt trọn vẹn cả dạo đầu và cao trào chorus)
    nfft = 8192
    hop = 4096
    slices = []
    if dur > 35.0:
        slices.append((max(2.0, dur * 0.25), 10.0))
        slices.append((max(10.0, dur * 0.60), 10.0))
    else:
        slices.append((max(1.0, dur * 0.15), min(20.0, max(4.0, dur * 0.7))))

    slice_powers = []
    for ss, tt in slices:
        cmd = [
            'ffmpeg', '-v', 'error',
            '-ss', str(ss), '-t', str(tt),
            '-i', str(p),
            '-f', 'f32le',
            '-ac', '1',
            '-'
        ]
        res = subprocess.run(cmd, capture_output=True)
        raw = np.frombuffer(res.stdout, dtype=np.float32)
        if len(raw) < nfft:
            continue
        num_frames = (len(raw) - nfft) // hop
        if num_frames < 1:
            continue
        frames = np.lib.stride_tricks.as_strided(
            raw,
            shape=(num_frames, nfft),
            strides=(raw.strides[0] * hop, raw.strides[0])
        )
        window = np.hanning(nfft)
        spec = np.fft.rfft(frames * window, axis=1)
        slice_powers.append(np.mean(np.abs(spec)**2, axis=0))

    if not slice_powers:
        print("   ❌ Không thể đọc âm thanh đủ để phân tích FFT.")
        return

    power = np.maximum.reduce(slice_powers)
    freqs = np.fft.rfftfreq(nfft, 1.0 / orig_sr)

    audible_mask = (freqs >= 1000) & (freqs <= 15000)
    peak_audible = np.max(power[audible_mask]) if np.any(audible_mask) else 1e-12

    def get_avg_db(f_low, f_high):
        m = (freqs >= f_low) & (freqs < f_high)
        if not np.any(m): return -120.0
        avg_p = np.mean(power[m])
        return float(10 * np.log10(max(avg_p, 1e-18) / peak_audible))

    db_10_15k = get_avg_db(10000, 15000)
    db_18_20k = get_avg_db(18000, 20000)
    db_20_22k = get_avg_db(20000, 22000)
    db_20_5_22k = get_avg_db(20500, 22000)
    db_22_24k = get_avg_db(22050, 24000) if orig_sr > 48000 else None
    db_24_32k = get_avg_db(24000, 32000) if orig_sr > 48000 else None
    drop_at_22k = (db_20_22k - db_22_24k) if db_22_24k is not None else 0.0
    drop_at_20_5k = db_18_20k - db_20_5_22k

    # Bit depth test if 24-bit
    has_24bit_bits = False
    if orig_bits > 16:
        cmd_s24 = [
            'ffmpeg', '-v', 'error',
            '-ss', str(max(2.0, dur * 0.2)), '-t', '10.0',
            '-i', str(p),
            '-f', 's24le',
            '-ac', '1',
            '-'
        ]
        res_s24 = subprocess.run(cmd_s24, capture_output=True)
        raw_s24 = res_s24.stdout
        if len(raw_s24) >= 3000:
            lsb = raw_s24[0::3]
            nz = sum(1 for b in lsb if b != 0)
            pct = (nz / len(lsb)) * 100.0
            has_24bit_bits = bool(pct >= 0.1)

    print(f"   Dải năng lượng: 18-20kHz: {db_18_20k:.1f} dB | 20-22kHz: {db_20_22k:.1f} dB", end="")
    if orig_sr > 48000:
        print(f" | 24-32kHz: {db_24_32k:.1f} dB | Độ sụt tại 22kHz: {drop_at_22k:.1f} dB")
    else:
        print()

    is_mp3_320k = bool(db_20_5_22k < -80.0 and drop_at_20_5k > 26.0 and db_18_20k > -55.0)
    is_mp3_low = bool(db_18_20k < -65.0 and (db_10_15k - db_18_20k) > 30.0)

    # Verdict
    if orig_sr > 48000:
        if is_mp3_320k or is_mp3_low or (db_18_20k < -65 and drop_at_22k > 14):
            print(f"   Kết luận: 🔴 FAKE HI-RES (NHẠC BỊ UPSIZE TỪ FILE MP3/AAC)")
            print(f"   Chi tiết: Dải tần số bị cắt cụt dưới 20kHz trước khi upsample lên {orig_sr/1000:.1f}kHz.")
        elif db_22_24k is not None and (db_24_32k < -80 or drop_at_22k > 18):
            print(f"   Kết luận: 🔴 FAKE HI-RES (NHẠC BỊ UPSIZE TỪ CD 44.1kHz)")
            print(f"   Chi tiết: File xuất xưởng {orig_sr/1000:.1f}kHz nhưng dải tần bị chặn đứng (brickwall) tại 22.05kHz. Dải siêu âm hoàn toàn là khoảng trống số ({db_24_32k:.1f} dB).")
        elif db_24_32k is not None and db_24_32k >= -65 and drop_at_22k < 12:
            print(f"   Kết luận: 🟢 TRUE HI-RES (HI-RES THẬT)")
            print(f"   Chi tiết: Dải hài âm thực tế mở rộng tự nhiên vượt mốc 24kHz ({db_24_32k:.1f} dB), không bị cắt cụt nhân tạo.")
        elif db_24_32k is not None and db_24_32k >= -75:
            print(f"   Kết luận: 🟢 TRUE HI-RES (BĂNG MASTER ANALOG GỐC)")
            print(f"   Chi tiết: Dải siêu âm suy giảm tự nhiên ({db_24_32k:.1f} dB), đặc trưng của bản thu âm master trên băng từ cổ điển.")
        else:
            print(f"   Kết luận: 🟡 SUSPICIOUS HI-RES (NGHI VẤN)")
            print(f"   Chi tiết: Năng lượng siêu âm rất thấp ({db_24_32k:.1f} dB).")
    elif is_mp3_320k:
        print(f"   Kết luận: 🔴 FAKE LOSSLESS (MP3 320k chuyển đổi thành FLAC)")
        print(f"   Chi tiết: Dải tần bị chặn đứng ở 20.5kHz đặc trưng của bộ nén MP3 320kbps LAME.")
    elif is_mp3_low:
        print(f"   Kết luận: 🔴 FAKE LOSSLESS (File MP3 128k-192k chuyển đổi thành FLAC)")
        print(f"   Chi tiết: Dải tần bị cắt cụt trước 18-20kHz đặc trưng của file nén MP3.")
    elif orig_bits > 16:
        if has_24bit_bits:
            print(f"   Kết luận: 🟡 STUDIO MASTER 24-BIT (Chuẩn 24-bit / {orig_sr/1000:.1f}kHz)")
            print(f"   Chi tiết: Bit depth 24-bit thật (dynamic range cao), tần số lấy mẫu tiêu chuẩn phòng thu ({orig_sr/1000:.1f}kHz).")
        else:
            print(f"   Kết luận: 🔴 FAKE 24-BIT (Chèn 8 bit 0 vào file 16-bit)")
            print(f"   Chi tiết: File đóng gói 24-bit nhưng dữ liệu thực chất chỉ là 16-bit.")
    else:
        print(f"   Kết luận: 🔵 CD LOSSLESS (Lossless chuẩn CD 16-bit / {orig_sr/1000:.1f}kHz)")
        print(f"   Chi tiết: File nhạc chuẩn CD Red Book nguyên bản, dải tần đầy đủ đến {orig_sr/2000:.1f}kHz.")

def main():
    if len(sys.argv) < 2:
        print_help()
        sys.exit(0)
        
    target = sys.argv[1]
    p = Path(target)
    if not p.exists():
        print(f"Lỗi: Không tìm thấy '{target}'")
        sys.exit(1)
        
    if p.is_file():
        check_single_file(p)
    elif p.is_dir():
        audio_exts = {'.flac', '.wav', '.dsf', '.m4a', '.mp3', '.ape', '.dff'}
        files = [f for f in p.rglob('*') if f.is_file() and f.suffix.lower() in audio_exts]
        print(f"Tìm thấy {len(files)} file âm thanh trong '{p.name}'. Bắt đầu kiểm tra...")
        for f in sorted(files):
            check_single_file(f)

if __name__ == '__main__':
    main()
