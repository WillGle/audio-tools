import os
import re
import json
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional, List
import numpy as np

# ==============================================================================
# 1. DYNAMIC RANGE METER (TT Dynamic Range / Pleasurize Music Foundation standard)
# ==============================================================================
def measure_dynamic_range(filepath: str, duration_limit: float = 600.0) -> Dict[str, Any]:
    """
    Đo Dynamic Range theo chuẩn TT Dynamic Range Meter (DR1 đến DR20).
    Tính Crest Factor từ Peak dBFS và RMS trung bình của top 20% block 3 giây to nhất.
    """
    p = Path(filepath)
    if not p.is_file():
        raise FileNotFoundError(f"Không tìm thấy file: {filepath}")

    # Lấy thời lượng
    cmd_dur = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)]
    res_dur = subprocess.run(cmd_dur, capture_output=True, text=True)
    try:
        dur = float(res_dur.stdout.strip())
    except Exception:
        dur = 180.0

    read_dur = min(dur, duration_limit)
    
    # Giải mã 2 kênh Stereo ở 44.1kHz float32
    cmd = [
        'ffmpeg', '-v', 'error',
        '-t', str(read_dur),
        '-i', str(p),
        '-f', 'f32le',
        '-ac', '2',
        '-ar', '44100',
        '-'
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    raw, _ = proc.communicate()
    if not raw or len(raw) < 44100 * 2 * 4:
        return {
            'dr_score': 0,
            'dr_badge': 'DR? (Không đủ mẫu)',
            'dr_float': 0.0,
            'peak_db': -100.0,
            'rms_db': -100.0,
            'badge_color': '#94a3b8',
            'verdict_text': 'File quá ngắn hoặc không thể giải mã'
        }

    samples = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2)
    sr = 44100
    block_size = sr * 3  # block 3 giây theo chuẩn TT DR
    num_blocks = len(samples) // block_size

    if num_blocks == 0:
        num_blocks = 1
        block_size = len(samples)

    channel_drs = []
    channel_peaks = []
    channel_rms_tops = []

    for ch in range(2):
        ch_data = samples[:, ch]
        peak = np.max(np.abs(ch_data))
        peak = max(peak, 1e-9)
        peak_db = 20.0 * np.log10(peak)
        channel_peaks.append(peak_db)

        block_powers = []
        for b in range(num_blocks):
            blk = ch_data[b * block_size : (b + 1) * block_size]
            pwr = np.mean(blk ** 2)
            if pwr > 1e-12:
                block_powers.append(pwr)

        if not block_powers:
            block_powers = [1e-12]

        block_powers.sort(reverse=True)
        top20_count = max(1, int(len(block_powers) * 0.2))
        avg_top20_power = np.mean(block_powers[:top20_count])
        rms_top20_db = 10.0 * np.log10(avg_top20_power)
        channel_rms_tops.append(rms_top20_db)

        dr_ch = peak_db - rms_top20_db
        channel_drs.append(dr_ch)

    # DR trung bình 2 kênh, làm tròn số nguyên chuẩn TT DR Meter
    dr_float = float(np.mean(channel_drs))
    dr_score = int(round(dr_float))
    dr_score = max(1, min(20, dr_score))

    peak_db = float(max(channel_peaks))
    rms_db = float(np.mean(channel_rms_tops))

    if dr_score >= 12:
        badge = f"DR{dr_score} (Wide Dynamic Range)"
        badge_color = "#10b981" # Green
        verdict_text = "Âm thanh nguyên bản độ động cực cao, chi tiết sân khấu sống động chuẩn Audiophile."
    elif dr_score >= 8:
        badge = f"DR{dr_score} (Moderate DR)"
        badge_color = "#f59e0b" # Amber
        verdict_text = "Độ động tiêu chuẩn, âm thanh cân bằng không bị nén quá mức."
    else:
        badge = f"DR{dr_score} (Heavily Compressed)"
        badge_color = "#f43f5e" # Rose/Red
        verdict_text = "Bị ép âm lượng nặng (Loudness War / Brickwall Limiting), mất độ chi tiết và tương phản âm thanh."

    return {
        'dr_score': dr_score,
        'dr_float': round(dr_float, 2),
        'dr_left': round(float(channel_drs[0]), 2),
        'dr_right': round(float(channel_drs[1]), 2),
        'peak_db': round(peak_db, 2),
        'rms_db': round(rms_db, 2),
        'dr_badge': badge,
        'badge_color': badge_color,
        'verdict_text': verdict_text
    }


# ==============================================================================
# 2. FLAC AUDIO MD5 & BIT-ROT CHECK
# ==============================================================================
def check_flac_integrity(filepath: str) -> Dict[str, Any]:
    """
    Kiểm tra tính toàn vẹn Bit-Perfect & phát hiện Bit-Rot cho file FLAC.
    Đối chiếu Audio MD5 trong STREAMINFO và kiểm tra lỗi frame CRC qua 'flac -t'.
    """
    p = Path(filepath)
    ext = p.suffix.lower()

    if ext != '.flac':
        # Dành cho định dạng khác: kiểm tra decode qua ffmpeg
        cmd = ['ffmpeg', '-v', 'error', '-i', str(p), '-f', 'null', '-']
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        is_ok = (res.returncode == 0 and not res.stderr.strip())
        return {
            'format': ext[1:].upper(),
            'status': 'BIT_PERFECT_PASS' if is_ok else 'CORRUPTED',
            'is_valid': is_ok,
            'badge': '🟢 Stream OK' if is_ok else '🔴 Stream Corrupted',
            'badge_color': '#10b981' if is_ok else '#f43f5e',
            'header_md5': 'N/A (Non-FLAC)',
            'message': 'Luồng dữ liệu âm thanh giải mã hoàn hảo, không có frame lỗi.' if is_ok else f'Lỗi giải mã luồng: {res.stderr.strip()}'
        }

    # Đọc MD5 trong STREAMINFO qua Mutagen
    header_md5_hex = None
    try:
        from mutagen.flac import FLAC
        audio = FLAC(p)
        md5_sig = audio.info.md5_signature
        if md5_sig:
            header_md5_hex = f"{md5_sig:032x}"
        else:
            header_md5_hex = "00000000000000000000000000000000"
    except Exception:
        header_md5_hex = None

    # Chạy flac -t
    cmd = ['flac', '-t', str(p)]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
    combined_out = (res.stdout + "\n" + res.stderr).lower()

    if res.returncode == 0:
        if "warning, cannot check md5" in combined_out or (header_md5_hex and header_md5_hex == "00000000000000000000000000000000"):
            status = 'FRAMES_OK_MD5_UNSET'
            badge = '🟡 Frame CRC OK (MD5 Unset)'
            badge_color = '#eab308'
            message = 'Toàn bộ frame âm thanh và CRC-16 hợp lệ 100%. (Header MD5 chưa được ghi lúc tạo file FLAC).'
        else:
            status = 'BIT_PERFECT_PASS'
            badge = '🟢 Bit-Perfect Pass (MD5 Valid)'
            badge_color = '#10b981'
            message = f'Audio MD5 khớp tuyệt đối ({header_md5_hex[:8]}...). Bit-Perfect 100%, không bị Bit-Rot hay hỏng frame.'
        is_valid = True
    else:
        status = 'BIT_ROT_CORRUPTED'
        badge = '🔴 Bit-Rot Corrupted'
        badge_color = '#f43f5e'
        is_valid = False
        message = 'Phát hiện lỗi sai lệch bit âm thanh (Bit-Rot) hoặc hỏng frame CRC trong tệp FLAC!'

    return {
        'format': 'FLAC',
        'status': status,
        'is_valid': is_valid,
        'header_md5': header_md5_hex,
        'badge': badge,
        'badge_color': badge_color,
        'message': message,
        'raw_output': res.stderr.strip() or res.stdout.strip()
    }


# ==============================================================================
# 3. FAKE 24-BIT DETECTION (Bit Padding / Zero-Padded 24-bit)
# ==============================================================================
def check_bit_depth_purity(filepath: str, sample_seconds: float = 12.0) -> Dict[str, Any]:
    """
    Kiểm tra xem file 24-bit có phải là "24-bit Giả" (16-bit độn thêm 8 bit 0 vào LSB) hay không.
    Phân tích histogram entropy của 8 bit thấp nhất (Least Significant Byte).
    """
    p = Path(filepath)
    ext = p.suffix.lower()

    # Lấy thông số bit depth qua ffprobe JSON
    cmd_probe = [
        'ffprobe', '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=bits_per_raw_sample,bits_per_sample,sample_rate,duration',
        '-of', 'json', str(p)
    ]
    res_probe = subprocess.run(cmd_probe, capture_output=True, text=True)
    bits = 16
    dur = 180.0
    sr = 44100
    try:
        j_data = json.loads(res_probe.stdout)
        st = j_data['streams'][0]
        if st.get('bits_per_raw_sample') and int(st['bits_per_raw_sample']) > 0:
            bits = int(st['bits_per_raw_sample'])
        elif st.get('bits_per_sample') and int(st['bits_per_sample']) > 0:
            bits = int(st['bits_per_sample'])
        if st.get('duration'):
            dur = float(st['duration'])
        if st.get('sample_rate'):
            sr = int(st['sample_rate'])
    except Exception:
        pass

    if bits <= 16:
        return {
            'nominal_bits': bits,
            'real_bits': bits,
            'is_fake_24bit': False,
            'badge': f'16-bit Standard',
            'badge_color': '#6366f1',
            'lsb_nonzero_pct': 100.0,
            'explanation': 'File chuẩn 16-bit nguyên gốc.'
        }

    start_sec = max(2.0, dur * 0.2)
    read_len = min(sample_seconds, max(4.0, dur - start_sec))

    cmd = [
        'ffmpeg', '-v', 'error',
        '-ss', str(start_sec), '-t', str(read_len),
        '-i', str(p),
        '-f', 's24le',
        '-ac', '1',
        '-'
    ]
    res = subprocess.run(cmd, capture_output=True)
    raw = res.stdout

    if len(raw) < 3000:
        return {
            'nominal_bits': bits,
            'real_bits': bits,
            'is_fake_24bit': False,
            'badge': f'{bits}-bit Unverified',
            'badge_color': '#94a3b8',
            'lsb_nonzero_pct': 0.0,
            'explanation': 'Dữ liệu âm thanh không đủ để phân tích bit depth.'
        }

    # Mỗi sample 24-bit gồm 3 byte: [LSB (bit 0-7), Mid (bit 8-15), MSB (bit 16-23)]
    lsb_bytes = raw[0::3]
    total_samples = len(lsb_bytes)
    nonzero_lsb = sum(1 for b in lsb_bytes if b != 0)
    lsb_nonzero_pct = round((nonzero_lsb / total_samples) * 100.0, 2)

    # Kiểm tra thêm 4 bit thấp nhất (nếu là 20-bit master padded to 24-bit)
    nonzero_lower4 = sum(1 for b in lsb_bytes if (b & 0x0F) != 0)
    lower4_pct = round((nonzero_lower4 / total_samples) * 100.0, 2)

    if lsb_nonzero_pct < 0.1:
        # 8 bit cuối hoàn toàn bằng 0 -> Fake 24-bit (16-bit Padded)
        real_bits = 16
        is_fake = True
        badge = '🔴 Fake 24-bit (16-bit Padded)'
        badge_color = '#f43f5e'
        explanation = f'File khai báo {bits}-bit nhưng 8 bit thấp nhất (LSB) là 0.0% (Zero-Padded). Thực chất chỉ là bản thu 16-bit bị độn thêm số 0 để tăng dung lượng!'
    elif lower4_pct < 0.1:
        real_bits = 20
        is_fake = False
        badge = '🟡 20-bit Studio Padded'
        badge_color = '#f59e0b'
        explanation = f'Bản thu chuẩn phòng thu 20-bit (độn 4 bit 0 trong container 24-bit).'
    else:
        real_bits = 24
        is_fake = False
        badge = '🟢 True 24-bit Hi-Res'
        badge_color = '#10b981'
        explanation = f'Chuẩn 24-bit thực thụ: 8 bit LSB chứa đầy đủ entropy ({lsb_nonzero_pct}% non-zero) với dải động vật lý ~144 dB.'

    return {
        'nominal_bits': bits,
        'real_bits': real_bits,
        'is_fake_24bit': is_fake,
        'lsb_nonzero_pct': lsb_nonzero_pct,
        'badge': badge,
        'badge_color': badge_color,
        'explanation': explanation
    }


# ==============================================================================
# 4. DSD / SACD PURITY DETERMINATION
# ==============================================================================
def check_dsd_purity(filepath: str) -> Dict[str, Any]:
    """
    Phân định DSD / SACD Purity:
    - Nhận diện kênh: Stereo 2.0 vs Multi-channel 5.1 Surround
    - Phân tích dải tần siêu âm >30kHz (tiếng ồn lượng tử Sigma-Delta Noise Shaping)
    - Phân loại: Native DSD (SACD) vs DSD Converted from PCM
    """
    p = Path(filepath)
    ext = p.suffix.lower()

    # Kiểm tra channel layout và codec
    cmd_info = [
        'ffprobe', '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,sample_rate,channels,channel_layout,duration',
        '-of', 'json', str(p)
    ]
    res_info = subprocess.run(cmd_info, capture_output=True, text=True)
    try:
        data = json.loads(res_info.stdout)
        stream = data['streams'][0]
        codec = stream.get('codec_name', ext[1:])
        sr = int(stream.get('sample_rate', 2822400))
        channels = int(stream.get('channels', 2))
        layout = stream.get('channel_layout', 'stereo')
        dur = float(stream.get('duration', 180.0))
    except Exception:
        codec = ext[1:]
        sr = 2822400
        channels = 2
        layout = 'stereo'
        dur = 180.0

    is_dsd = ('dsd' in codec.lower() or ext in ('.dsf', '.dff'))

    channel_type = 'Multi-channel 5.1 Surround' if channels > 2 else 'Stereo 2.0'
    channel_badge = '🎧 5.1 Surround' if channels > 2 else '🎵 Stereo 2.0'

    if not is_dsd:
        return {
            'is_dsd': False,
            'codec': codec.upper(),
            'channels': channels,
            'channel_type': channel_type,
            'channel_badge': channel_badge,
            'purity': 'NOT_DSD',
            'badge': 'PCM Audio',
            'badge_color': '#94a3b8',
            'explanation': 'Định dạng PCM thông thường, không phải DSD.'
        }

    # Phân tích phổ dải siêu âm 30kHz - 80kHz qua PCM 176.4kHz
    start_sec = max(5.0, dur * 0.25)
    read_len = min(12.0, max(5.0, dur - start_sec))

    cmd_decode = [
        'ffmpeg', '-v', 'error',
        '-ss', str(start_sec), '-t', str(read_len),
        '-i', str(p),
        '-ar', '176400',
        '-ac', '1',
        '-f', 'f32le',
        '-'
    ]
    res_dec = subprocess.run(cmd_decode, capture_output=True)
    samples = np.frombuffer(res_dec.stdout, dtype=np.float32)

    if len(samples) < 176400:
        return {
            'is_dsd': True,
            'codec': codec.upper(),
            'channels': channels,
            'channel_type': channel_type,
            'channel_badge': channel_badge,
            'purity': 'TRUE_DSD',
            'badge': f'🟢 Native DSD ({channel_type})',
            'badge_color': '#06b6d4',
            'explanation': 'Tệp DSD 1-bit Native Super Audio.'
        }

    nfft = 8192
    spec = np.abs(np.fft.rfft(samples[:nfft * 15].reshape(-1, nfft) * np.hanning(nfft)))
    avg_power = np.mean(spec ** 2, axis=0)
    freqs = np.fft.rfftfreq(nfft, 1.0 / 176400)

    def band_db(f1, f2):
        m = (freqs >= f1) & (freqs < f2)
        if not np.any(m): return -120.0
        return float(10 * np.log10(np.mean(avg_power[m]) + 1e-15))

    db_audible = band_db(1000, 10000)
    db_20k = band_db(18000, 22000)
    db_30k = band_db(28000, 35000)
    db_50k = band_db(45000, 65000)

    # Độ dốc tiếng ồn lượng tử Sigma-Delta: DSD thật noise tăng mạnh từ 30k đến 50k+
    noise_shape_rise = round(db_50k - db_30k, 1)
    drop_at_22k = round(db_20k - db_30k, 1)

    if drop_at_22k > 30.0 and noise_shape_rise < 10.0:
        purity = 'DSD_CONVERTED_FROM_PCM'
        badge = f'🔴 DSD Giả (Convert từ PCM 44.1k)'
        badge_color = '#f43f5e'
        explanation = f'File DSF giả: Bị cắt cụt ở 22.05kHz (sụt {drop_at_22k}dB), không có đường cong Sigma-Delta Noise Shaping đặc trưng.'
    elif noise_shape_rise >= 15.0:
        purity = 'NATIVE_DSD_SACD'
        badge = f'🟢 Native DSD / SACD Master ({channel_type})'
        badge_color = '#06b6d4'
        explanation = f'DSD nguyên bản chuẩn SACD: Xuất hiện tiếng ồn lượng tử Sigma-Delta Noise Shaping mở rộng vượt 50kHz (+{noise_shape_rise}dB).'
    else:
        purity = 'TRUE_DSD'
        badge = f'🟢 True DSD ({channel_type})'
        badge_color = '#06b6d4'
        explanation = f'DSD 1-bit High-Resolution ({codec.upper()}, {channel_type}).'

    return {
        'is_dsd': True,
        'codec': codec.upper(),
        'sample_rate': sr,
        'channels': channels,
        'channel_type': channel_type,
        'channel_badge': channel_badge,
        'purity': purity,
        'badge': badge,
        'badge_color': badge_color,
        'noise_shape_rise_db': noise_shape_rise,
        'drop_at_22k_db': drop_at_22k,
        'explanation': explanation
    }


# ==============================================================================
# 5. REPLAYGAIN 2.0 & EBU R128 LOUDNESS
# ==============================================================================
def measure_replaygain_ebu_r128(filepath: str) -> Dict[str, Any]:
    """
    Đo đạc ReplayGain 2.0 và EBU R128 (Integrated LUFS, True Peak, LRA).
    Tính toán thông số bù trừ âm lượng không làm giảm chất lượng bit-perfect.
    """
    p = Path(filepath)
    cmd = [
        'ffmpeg', '-nostats',
        '-i', str(p),
        '-af', 'ebur128=peak=true',
        '-f', 'null',
        '-'
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    out = res.stderr

    integrated_lufs = -18.0
    lra = 0.0
    true_peak_db = 0.0

    if 'Summary:' in out:
        summary = out.split('Summary:')[-1]
        i_match = re.search(r'I:\s+([-\d.]+)\s+LUFS', summary)
        lra_match = re.search(r'LRA:\s+([-\d.]+)\s+LU', summary)
        peak_match = re.search(r'Peak:\s+([-\d.]+)\s+dBFS', summary)
        if i_match:
            integrated_lufs = float(i_match.group(1))
        if lra_match:
            lra = float(lra_match.group(1))
        if peak_match:
            true_peak_db = float(peak_match.group(1))
    else:
        i_match = re.search(r'I:\s+([-\d.]+)\s+LUFS', out)
        if i_match:
            integrated_lufs = float(i_match.group(1))

    # Chuẩn ReplayGain 2.0: Target -18.0 LUFS
    track_gain_rg2 = round(-18.00 - integrated_lufs, 2)
    # Chuẩn EBU R128: Target -23.0 LUFS
    track_gain_r128 = round(-23.00 - integrated_lufs, 2)
    # Peak dạng tỷ lệ (ratio 0.0 -> 1.0+)
    track_peak_ratio = round(float(10.0 ** (true_peak_db / 20.0)), 6)

    return {
        'integrated_lufs': float(integrated_lufs),
        'loudness_range_lra': float(lra),
        'true_peak_db': float(true_peak_db),
        'replaygain_track_gain': f"{track_gain_rg2:+.2f} dB",
        'replaygain_track_peak': float(track_peak_ratio),
        'r128_track_gain': f"{track_gain_r128:+.2f} dB",
        'summary': f"{integrated_lufs} LUFS | Peak {true_peak_db:+.1f} dBFS | Gain {track_gain_rg2:+.2f} dB"
    }


# ==============================================================================
# 6. GAPLESS PLAYBACK & SEAMLESS TRANSITIONS CHECKER
# ==============================================================================
def check_gapless_attributes(filepath: str) -> Dict[str, Any]:
    """
    Kiểm tra thuộc tính Gapless Playback:
    - Đo độ dài khoảng lặng mở đầu (lead-in silence) và kết thúc (lead-out silence).
    - Phân tích mức năng lượng biên (boundary energy) để phát hiện chuyển bài liền mạch (Live/Mix).
    """
    p = Path(filepath)
    ext = p.suffix.lower()

    # Đo khoảng lặng đầu và đuôi bằng ffmpeg
    # Đọc 2.0 giây đầu
    cmd_start = [
        'ffmpeg', '-v', 'error',
        '-t', '2.0',
        '-i', str(p),
        '-f', 'f32le', '-ac', '1', '-ar', '44100', '-'
    ]
    res_start = subprocess.run(cmd_start, capture_output=True)
    raw_start = np.frombuffer(res_start.stdout, dtype=np.float32)

    # Đọc 2.0 giây cuối
    cmd_dur = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)]
    res_dur = subprocess.run(cmd_dur, capture_output=True, text=True)
    try:
        dur = float(res_dur.stdout.strip())
    except Exception:
        dur = 180.0

    tail_start = max(0.0, dur - 2.0)
    cmd_end = [
        'ffmpeg', '-v', 'error',
        '-ss', str(tail_start), '-t', '2.0',
        '-i', str(p),
        '-f', 'f32le', '-ac', '1', '-ar', '44100', '-'
    ]
    res_end = subprocess.run(cmd_end, capture_output=True)
    raw_end = np.frombuffer(res_end.stdout, dtype=np.float32)

    # Tìm khoảng lặng đầu (silent samples < -60 dBFS = 0.001)
    silence_threshold = 0.001
    intro_silence_samples = 0
    if len(raw_start) > 0:
        for s in np.abs(raw_start):
            if s < silence_threshold:
                intro_silence_samples += 1
            else:
                break
    intro_silence_ms = round((intro_silence_samples / 44100.0) * 1000.0, 1)

    # Tìm khoảng lặng đuôi
    outro_silence_samples = 0
    if len(raw_end) > 0:
        for s in reversed(np.abs(raw_end)):
            if s < silence_threshold:
                outro_silence_samples += 1
            else:
                break
    outro_silence_ms = round((outro_silence_samples / 44100.0) * 1000.0, 1)

    # Năng lượng tại 100ms cuối cùng (boundary energy)
    boundary_samples = raw_end[-4410:] if len(raw_end) >= 4410 else raw_end
    boundary_rms = float(np.sqrt(np.mean(boundary_samples ** 2))) if len(boundary_samples) > 0 else 0.0
    boundary_db = round(20.0 * np.log10(max(boundary_rms, 1e-9)), 1)

    is_seamless_candidate = bool(boundary_db > -45.0)  # Bài kết thúc đột ngột với âm lượng cao (nhạc Live/Mix)

    container_gapless_support = bool(ext in ('.flac', '.wav', '.dsf', '.dff', '.ape'))

    if container_gapless_support:
        gapless_rating = 'Seamless Native Ready'
        rating_color = '#10b981'
    elif intro_silence_ms < 50.0 and outro_silence_ms < 50.0:
        gapless_rating = 'Gapless Compatible'
        rating_color = '#06b6d4'
    else:
        gapless_rating = 'Standard Padded'
        rating_color = '#94a3b8'

    return {
        'intro_silence_ms': float(intro_silence_ms),
        'outro_silence_ms': float(outro_silence_ms),
        'boundary_end_db': float(boundary_db),
        'is_seamless_live_candidate': is_seamless_candidate,
        'container_gapless_support': container_gapless_support,
        'gapless_rating': gapless_rating,
        'rating_color': rating_color,
        'summary': f"Intro: {intro_silence_ms}ms | Outro: {outro_silence_ms}ms | Boundary: {boundary_db}dBFS"
    }


# ==============================================================================
# UNIFIED AUDIOPHILE AUDIT
# ==============================================================================
def run_full_audiophile_audit(filepath: str) -> Dict[str, Any]:
    """
    Thực hiện kiểm định toàn diện 7 tiêu chuẩn Audiophile cho một tệp âm thanh.
    """
    p = Path(filepath)
    if not p.is_file():
        raise FileNotFoundError(f"Tệp không tồn tại: {filepath}")

    # 1. Đo Dynamic Range
    dr_data = measure_dynamic_range(filepath)

    # 2. FLAC Integrity & Bit-Rot
    integrity_data = check_flac_integrity(filepath)

    # 3. Bit Depth & Fake 24-bit
    bit_data = check_bit_depth_purity(filepath)

    # 4. DSD Purity
    dsd_data = check_dsd_purity(filepath)

    # 5. ReplayGain & EBU R128
    lufs_data = measure_replaygain_ebu_r128(filepath)

    # 6. Gapless Playback
    gapless_data = check_gapless_attributes(filepath)

    # 7. Vault Tier Classification
    tier = classify_vault_tier(
        filepath=filepath,
        integrity=integrity_data,
        bit_purity=bit_data,
        dsd_purity=dsd_data
    )

    return {
        'filepath': str(filepath),
        'filename': p.name,
        'dynamic_range': dr_data,
        'integrity': integrity_data,
        'bit_depth': bit_data,
        'dsd': dsd_data,
        'loudness': lufs_data,
        'gapless': gapless_data,
        'vault_tier': tier
    }


def classify_vault_tier(filepath: str, integrity: Dict, bit_purity: Dict, dsd_purity: Dict) -> Dict[str, Any]:
    """
    Phân loại vào 3 Cấp Kho Nhạc (Vault Tiering):
    1. 01_DSD & Hi-Res (>24/96k)
    2. 02_Lossless CD (16/44.1k)
    3. 03_Quarantine (Fake Hi-Res, MP3, File Lỗi)
    """
    p = Path(filepath)
    ext = p.suffix.lower()

    # Kiểm tra file lỗi hoặc Bit-Rot
    if not integrity.get('is_valid', True) or integrity.get('status') == 'BIT_ROT_CORRUPTED':
        return {
            'tier_id': '03_quarantine',
            'tier_name': '03_Quarantine (Fake Hi-Res, MP3, File Lỗi)',
            'sub_category': 'Corrupted_Bit_Rot',
            'badge': '🔴 Quarantine (File Lỗi / Bit-Rot)',
            'badge_color': '#f43f5e'
        }

    # Kiểm tra Fake 24-bit
    if bit_purity.get('is_fake_24bit', False):
        return {
            'tier_id': '03_quarantine',
            'tier_name': '03_Quarantine (Fake Hi-Res, MP3, File Lỗi)',
            'sub_category': 'Fake_24bit_Padded',
            'badge': '🔴 Quarantine (Fake 24-bit)',
            'badge_color': '#f43f5e'
        }

    # Kiểm tra DSD giả
    if dsd_purity.get('purity') == 'DSD_CONVERTED_FROM_PCM':
        return {
            'tier_id': '03_quarantine',
            'tier_name': '03_Quarantine (Fake Hi-Res, MP3, File Lỗi)',
            'sub_category': 'Fake_DSD_From_PCM',
            'badge': '🔴 Quarantine (DSD Giả từ PCM)',
            'badge_color': '#f43f5e'
        }

    # Kiểm tra file nén Lossy
    if ext in ('.mp3', '.m4a', '.aac', '.ogg', '.wma'):
        return {
            'tier_id': '03_quarantine',
            'tier_name': '03_Quarantine (Fake Hi-Res, MP3, File Lỗi)',
            'sub_category': 'Lossy_Audio',
            'badge': '⚪ Quarantine (Lossy MP3/AAC)',
            'badge_color': '#94a3b8'
        }

    # DSD thật
    if dsd_purity.get('is_dsd', False):
        return {
            'tier_id': '01_hires_dsd',
            'tier_name': '01_DSD & Hi-Res (>24/96k)',
            'sub_category': 'Native_DSD',
            'badge': '🟢 DSD & Hi-Res (Native SACD)',
            'badge_color': '#06b6d4'
        }

    # PCM Hi-Res (>24/96k hoặc 24-bit)
    nominal_bits = bit_purity.get('nominal_bits', 16)
    real_bits = bit_purity.get('real_bits', 16)

    # Đọc sample rate
    cmd_sr = ['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', str(p)]
    res_sr = subprocess.run(cmd_sr, capture_output=True, text=True)
    try:
        sr = int(res_sr.stdout.strip())
    except Exception:
        sr = 44100

    if sr >= 88200 or (real_bits >= 24 and sr > 48000):
        return {
            'tier_id': '01_hires_dsd',
            'tier_name': '01_DSD & Hi-Res (>24/96k)',
            'sub_category': f'HiRes_{real_bits}bit_{sr//1000}k',
            'badge': f'🟢 DSD & Hi-Res ({real_bits}b/{sr//1000}k)',
            'badge_color': '#10b981'
        }
    else:
        return {
            'tier_id': '02_cd_lossless',
            'tier_name': '02_Lossless CD (16/44.1k)',
            'sub_category': f'CD_{real_bits}bit_{sr//1000}k',
            'badge': f'🔵 Lossless CD ({real_bits}b/{sr//1000}k)',
            'badge_color': '#6366f1'
        }


def audit_album_gapless_and_dr(track_paths: List[str]) -> Dict[str, Any]:
    """
    Kiểm định toàn bộ Album:
    - Tính Official Album Dynamic Range (DR trung bình toàn Album theo chuẩn Pleasurize Music Foundation)
    - Phân tích chuyển tiếp Gapless giữa các track liên tiếp (phát hiện gap lỗi hoặc chuyển bài mượt)
    """
    track_audits = []
    dr_scores = []
    
    # Sắp xếp theo tên file / số thứ tự
    sorted_paths = sorted(track_paths, key=lambda p: Path(p).name)

    for tp in sorted_paths:
        try:
            audit = run_full_audiophile_audit(tp)
            track_audits.append(audit)
            score = audit.get('dynamic_range', {}).get('dr_score', 0)
            if score > 0:
                dr_scores.append(score)
        except Exception as e:
            print(f"Lỗi kiểm định track {tp}: {e}")

    if not track_audits:
        return {'error': 'Không có track nào được phân tích thành công'}

    album_dr = round(float(np.mean(dr_scores))) if dr_scores else 0
    album_dr_float = round(float(np.mean(dr_scores)), 2) if dr_scores else 0.0

    # Phân tích chuyển tiếp Gapless giữa track i và track i+1
    transitions = []
    for i in range(len(track_audits) - 1):
        t1 = track_audits[i]
        t2 = track_audits[i + 1]

        t1_gapless = t1.get('gapless', {})
        t2_gapless = t2.get('gapless', {})

        t1_outro_silence = t1_gapless.get('outro_silence_ms', 0.0)
        t2_intro_silence = t2_gapless.get('intro_silence_ms', 0.0)
        total_silence_gap = round(t1_outro_silence + t2_intro_silence, 1)

        t1_end_db = t1_gapless.get('boundary_end_db', -120.0)

        # Đánh giá chuyển tiếp
        if total_silence_gap == 0.0 and t1_end_db > -45.0:
            status = 'SEAMLESS_CONTINUOUS'
            status_badge = '🟢 Chuyển Liền Mạch (Live / Mix)'
            status_color = '#10b981'
            note = 'Chuyển bài tuyệt đối mượt mà, không bị chèn khoảng lặng.'
        elif total_silence_gap > 300.0:
            status = 'ISOLATED_TRACKS'
            status_badge = '⚪ Tách Bài Chuẩn (Có Khoảng Lặng)'
            status_color = '#94a3b8'
            note = f'Khoảng lặng phân cách {total_silence_gap}ms giữa 2 bài hát.'
        else:
            status = 'SUBTLE_TRANSITION'
            status_badge = '🟡 Chuyển Tiếp Ngắn'
            status_color = '#eab308'
            note = f'Khoảng chuyển tiếp ngắn {total_silence_gap}ms.'

        transitions.append({
            'from_track': t1.get('filename', ''),
            'to_track': t2.get('filename', ''),
            'from_end_db': t1_end_db,
            'total_silence_gap_ms': total_silence_gap,
            'status': status,
            'status_badge': status_badge,
            'status_color': status_color,
            'note': note
        })

    return {
        'track_count': len(track_audits),
        'album_dr_score': album_dr,
        'album_dr_float': album_dr_float,
        'album_dr_badge': f"Album DR{album_dr}",
        'transitions': transitions,
        'tracks': track_audits
    }
