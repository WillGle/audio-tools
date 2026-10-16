import os
import subprocess
from pathlib import Path

def get_audio_specs(filepath):
    p = Path(filepath)
    cmd = [
        'ffprobe', '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=sample_rate,bits_per_raw_sample,bits_per_sample,codec_name,channels,duration',
        '-of', 'csv=p=0',
        str(p)
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
        parts = res.stdout.strip().split(',')
        codec = parts[0] if len(parts) > 0 else p.suffix[1:]
        sr = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 44100
        bits = 16
        for pt in parts[2:4]:
            if pt.isdigit() and int(pt) > 0:
                bits = int(pt)
                break
        channels = int(parts[4]) if len(parts) > 4 and parts[4].isdigit() else 2
        dur = float(parts[5]) if len(parts) > 5 and parts[5].replace('.', '', 1).isdigit() else 180.0
        return {
            'codec': codec,
            'sample_rate': sr,
            'bit_depth': bits,
            'channels': channels,
            'duration': dur
        }
    except Exception:
        return {
            'codec': p.suffix[1:],
            'sample_rate': 44100,
            'bit_depth': 16,
            'channels': 2,
            'duration': 180.0
        }

def analyze_audio_file(filepath):
    p = Path(filepath)
    ext = p.suffix.lower()
    
    if ext in ('.mp3', '.m4a', '.aac', '.ogg', '.wma'):
        specs = get_audio_specs(filepath)
        if specs['codec'] in ('aac', 'mp3', 'vorbis', 'opus'):
            return {
                'filepath': str(filepath),
                'filename': p.name,
                'codec': specs['codec'].upper(),
                'sample_rate': specs['sample_rate'],
                'bit_depth': specs['bit_depth'],
                'verdict': 'LOSSY',
                'badge': '⚪ Lossy (MP3/AAC)',
                'badge_color': '#94a3b8',
                'explanation': f'Định dạng nén tổn hao ({specs["codec"].upper()} ~{specs["sample_rate"]}Hz), bị cắt tần số từ 16kHz - 20kHz.',
                'drop_at_22k': 0.0,
                'ultrasonic_db': -100.0,
                'has_24bit_bits': False
            }

    specs = get_audio_specs(filepath)
    codec = specs['codec']
    sr = specs['sample_rate']
    bits = specs['bit_depth']
    dur = specs['duration']

    if 'dsd' in codec or ext in ('.dsf', '.dff'):
        return {
            'filepath': str(filepath),
            'filename': p.name,
            'codec': codec.upper(),
            'sample_rate': sr,
            'bit_depth': 1,
            'verdict': 'TRUE_DSD',
            'badge': '🟢 True DSD (Super Audio)',
            'badge_color': '#06b6d4',
            'explanation': f'DSD 1-bit Native Super Audio ({codec.upper()}, {sr/1000:.1f}kHz) chất lượng cao nguyên bản.',
            'drop_at_22k': 0.0,
            'ultrasonic_db': -50.0,
            'has_24bit_bits': True
        }

    # Đọc đoạn âm thanh PCM
    start_sec = max(2.0, dur * 0.25)
    read_len = min(25.0, max(5.0, dur - start_sec))
    
    cmd = [
        'ffmpeg', '-v', 'error',
        '-ss', str(start_sec), '-t', str(read_len),
        '-i', str(p),
        '-f', 's32le',
        '-ac', '1',
        '-'
    ]
    res = subprocess.run(cmd, capture_output=True)
    import numpy as np
    raw = np.frombuffer(res.stdout, dtype=np.int32)
    if len(raw) == 0:
        return {
            'filepath': str(filepath),
            'filename': p.name,
            'verdict': 'ERROR',
            'badge': '❌ Lỗi đọc file',
            'badge_color': '#ef4444',
            'explanation': 'Không thể giải mã dữ liệu âm thanh.'
        }

    nonzero_mask = np.bitwise_or.reduce(np.abs(raw))
    has_24bit_bits = bool(nonzero_mask & 0x0000FF00)

    nfft = 8192
    hop = 4096
    num_frames = (len(raw) - nfft) // hop
    if num_frames < 1:
        return {
            'filepath': str(filepath),
            'filename': p.name,
            'verdict': 'ERROR',
            'badge': '❌ File quá ngắn',
            'badge_color': '#ef4444',
            'explanation': 'Đoạn âm thanh quá ngắn để phân tích FFT.'
        }

    frames = np.lib.stride_tricks.as_strided(
        raw,
        shape=(num_frames, nfft),
        strides=(raw.strides[0] * hop, raw.strides[0])
    )
    window = np.hanning(nfft)
    spec = np.fft.rfft(frames * window, axis=1)
    power = np.mean(np.abs(spec)**2, axis=0)
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)

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
    db_22_24k = get_avg_db(22050, 24000) if sr > 48000 else None
    db_24_32k = get_avg_db(24000, 32000) if sr > 48000 else None
    drop_at_22k = round((db_20_22k - db_22_24k) if db_22_24k is not None else 0.0, 1)

    if sr > 48000:
        if db_22_24k is not None and (db_24_32k < -80 or drop_at_22k > 18):
            verdict = 'FAKE_HIRES_UPSAMPLED'
            badge = '🔴 Fake Hi-Res (Upsize từ CD)'
            badge_color = '#f43f5e'
            explanation = f'File gán mác {sr/1000:.1f}kHz nhưng dải tần bị cắt đứng ở 22.05kHz (sụt {drop_at_22k}dB), dải siêu âm rỗng ({db_24_32k:.1f}dB).'
        elif db_18_20k < -65 and drop_at_22k > 14:
            verdict = 'FAKE_HIRES_UPSAMPLED'
            badge = '🔴 Fake Hi-Res (Upsize từ MP3)'
            badge_color = '#f43f5e'
            explanation = f'File bị upsample từ file nén MP3 (dải tần bị cắt cụt dưới 20kHz).'
        elif db_24_32k is not None and db_24_32k >= -65 and drop_at_22k < 12:
            verdict = 'TRUE_HIRES'
            badge = '🟢 True Hi-Res'
            badge_color = '#10b981'
            explanation = f'Chuẩn Hi-Res thực thụ: Dải sóng hài siêu âm mở rộng vượt 24kHz ({db_24_32k:.1f}dB) tự nhiên.'
        elif db_24_32k is not None and db_24_32k >= -75:
            verdict = 'TRUE_HIRES'
            badge = '🟢 True Hi-Res (Master Tape)'
            badge_color = '#10b981'
            explanation = f'Chuẩn Hi-Res bản master analog: Dải siêu âm suy giảm tự nhiên ({db_24_32k:.1f}dB) đặc trưng băng từ gốc.'
        else:
            verdict = 'SUSPICIOUS_HIRES'
            badge = '🟡 Hi-Res Nghi Vấn'
            badge_color = '#eab308'
            explanation = f'Năng lượng siêu âm rất yếu ({db_24_32k:.1f}dB).'
    elif bits > 16:
        if has_24bit_bits:
            verdict = 'STUDIO_MASTER_24BIT'
            badge = f'🟡 Studio Master {bits}bit/{sr/1000:.1f}k'
            badge_color = '#f59e0b'
            explanation = f'Đạt chuẩn phòng thu {bits}-bit thật với Dynamic Range cao (~144dB).'
        else:
            verdict = 'FAKE_24BIT'
            badge = '🔴 Fake 24-bit (Độn bit 0)'
            badge_color = '#f43f5e'
            explanation = 'Vỏ bọc 24-bit nhưng 8 bit cuối toàn số 0 (thực chất chỉ là 16-bit).'
    else:
        if db_18_20k < -60 and (db_10_15k - db_18_20k) > 35:
            verdict = 'FAKE_LOSSLESS'
            badge = '🔴 Fake Lossless (MP3 -> FLAC)'
            badge_color = '#fb7185'
            explanation = 'File 16-bit FLAC nhưng ruột là MP3 nén (bị cắt tần trước 18-20kHz).'
        else:
            verdict = 'CD_LOSSLESS'
            badge = f'🔵 CD Lossless ({sr/1000:.1f}k)'
            badge_color = '#6366f1'
            explanation = f'Lossless chuẩn CD Red Book 16-bit / {sr/1000:.1f}kHz nguyên bản.'

    return {
        'filepath': str(filepath),
        'filename': p.name,
        'codec': codec.upper(),
        'sample_rate': sr,
        'bit_depth': bits,
        'has_24bit_bits': has_24bit_bits,
        'db_18_20k': round(db_18_20k, 1),
        'db_20_22k': round(db_20_22k, 1),
        'db_22_24k': round(db_22_24k, 1) if db_22_24k is not None else None,
        'ultrasonic_db': round(db_24_32k, 1) if db_24_32k is not None else -120.0,
        'drop_at_22k': drop_at_22k,
        'verdict': verdict,
        'badge': badge,
        'badge_color': badge_color,
        'explanation': explanation
    }

def generate_spectrogram_image(filepath, output_png_path):
    p = Path(filepath)
    out_p = Path(output_png_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    
    cmd = [
        'ffmpeg', '-y',
        '-i', str(p),
        '-lavfi', 'showspectrumpic=s=1200x500:legend=1:color=intensity',
        '-frames:v', '1',
        str(out_p)
    ]
    res = subprocess.run(cmd, capture_output=True, timeout=30)
    return out_p.exists()
