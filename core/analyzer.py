import os
import json
import subprocess
from pathlib import Path
import numpy as np

def get_audio_specs(filepath):
    p = Path(filepath)
    ext = p.suffix.lower()
    
    cmd = [
        'ffprobe', '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,sample_rate,bits_per_raw_sample,bits_per_sample,channels,duration',
        '-of', 'json',
        str(p)
    ]
    codec = ext.lstrip('.')
    sr = 44100
    bits = 16
    channels = 2
    dur = 180.0

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
        data = json.loads(res.stdout)
        if 'streams' in data and len(data['streams']) > 0:
            st = data['streams'][0]
            codec = st.get('codec_name', codec)
            if st.get('sample_rate'):
                sr = int(st['sample_rate'])
            
            raw_b = st.get('bits_per_raw_sample')
            std_b = st.get('bits_per_sample')
            if raw_b and int(raw_b) > 0:
                bits = int(raw_b)
            elif std_b and int(std_b) > 0:
                bits = int(std_b)

            if st.get('channels'):
                channels = int(st['channels'])
            if st.get('duration'):
                dur = float(st['duration'])
    except Exception:
        pass

    # Bổ sung kiểm tra bằng mutagen nếu định dạng FLAC/DSF
    if ext == '.flac':
        try:
            from mutagen.flac import FLAC
            audio = FLAC(p)
            if hasattr(audio, 'info'):
                if getattr(audio.info, 'bits_per_sample', 0) > 0:
                    bits = audio.info.bits_per_sample
                if getattr(audio.info, 'sample_rate', 0) > 0:
                    sr = audio.info.sample_rate
                if getattr(audio.info, 'length', 0) > 0:
                    dur = audio.info.length
                if getattr(audio.info, 'channels', 0) > 0:
                    channels = audio.info.channels
        except Exception:
            pass
    elif ext in ('.dsf', '.dff'):
        bits = 1
        codec = 'dsd'

    return {
        'codec': codec,
        'sample_rate': sr,
        'bit_depth': bits,
        'channels': channels,
        'duration': dur
    }

def find_spectral_cutoff(power, freqs, sr):
    """
    Thuật toán quét ngược phổ (Reverse Spectral Sweeping) theo chuẩn fakeflac.
    Tìm điểm cắt tần số (cutoff frequency Hz) và độ sụt biên (cliff drop dB).
    """
    w = 16
    smoothed = np.convolve(10 * np.log10(np.maximum(power, 1e-15)), np.ones(w) / float(w), mode='same')
    audible = (freqs >= 1000) & (freqs <= 15000)
    ref = np.max(smoothed[audible]) if np.any(audible) else 0.0
    norm_db = smoothed - ref

    nyquist = sr / 2.0
    cutoff_freq = nyquist
    max_drop = 0.0

    for i in range(len(freqs) - 2, 0, -1):
        f = freqs[i]
        if f < 14000:
            break
        idx_prev = np.searchsorted(freqs, max(1000, f - 800))
        drop = norm_db[idx_prev] - norm_db[i]
        if drop > 25.0 and norm_db[i] < -75.0 and drop > max_drop:
            max_drop = drop
            cutoff_freq = f

    return round(float(cutoff_freq)), round(float(max_drop), 1)

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
                'cutoff_hz': min(specs['sample_rate'] // 2, 20000),
                'cutoff_drop_db': 60.0,
                'ultrasonic_db': -100.0,
                'has_24bit_bits': False
            }

    specs = get_audio_specs(filepath)
    codec = specs['codec']
    sr = specs['sample_rate']
    bits = specs['bit_depth']
    dur = specs['duration']

    if 'dsd' in codec.lower() or ext in ('.dsf', '.dff'):
        from core.audiophile_engine import check_dsd_purity
        dsd_res = check_dsd_purity(str(filepath))
        return {
            'filepath': str(filepath),
            'filename': p.name,
            'codec': codec.upper(),
            'sample_rate': sr,
            'bit_depth': 1,
            'verdict': dsd_res.get('purity', 'TRUE_DSD'),
            'badge': dsd_res.get('badge', '🟢 True DSD (Super Audio)'),
            'badge_color': dsd_res.get('badge_color', '#06b6d4'),
            'explanation': dsd_res.get('explanation', f'DSD 1-bit Native Super Audio ({codec.upper()}, {sr/1000:.1f}kHz) chất lượng cao nguyên bản.'),
            'drop_at_22k': dsd_res.get('drop_at_22k_db', 0.0),
            'cutoff_hz': sr // 2,
            'cutoff_drop_db': 0.0,
            'ultrasonic_db': -50.0,
            'has_24bit_bits': True
        }

    # Lấy mẫu đa điểm (Multi-window sampling) để tránh báo động giả do intro êm
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
        pwr = np.mean(np.abs(spec)**2, axis=0)
        slice_powers.append(pwr)

    if not slice_powers:
        return {
            'filepath': str(filepath),
            'filename': p.name,
            'verdict': 'ERROR',
            'badge': '❌ Không thể đọc âm thanh',
            'badge_color': '#ef4444',
            'explanation': 'Không thể giải mã dữ liệu âm thanh đủ để phân tích phổ FFT.'
        }

    # Kết hợp năng lượng phổ bằng giá trị lớn nhất giữa các slice (bắt được trọn vẹn dải hài âm ở điệp khúc)
    power = np.maximum.reduce(slice_powers)
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)

    audible_mask = (freqs >= 1000) & (freqs <= 15000)
    peak_audible = np.max(power[audible_mask]) if np.any(audible_mask) else 1e-12

    def get_avg_db(f_low, f_high):
        m = (freqs >= f_low) & (freqs < f_high)
        if not np.any(m): return -120.0
        avg_p = np.mean(power[m])
        return float(10 * np.log10(max(avg_p, 1e-18) / peak_audible))

    db_10_15k = get_avg_db(10000, 15000)
    db_16_18k = get_avg_db(16000, 18000)
    db_18_20k = get_avg_db(18000, 20000)
    db_20_20_5k = get_avg_db(20000, 20500)
    db_20_5_22k = get_avg_db(20500, 22000)
    db_20_22k = get_avg_db(20000, 22000)
    db_22_24k = get_avg_db(22050, 24000) if sr > 48000 else None
    db_24_32k = get_avg_db(24000, 32000) if sr > 48000 else None
    
    drop_at_22k = round((db_20_22k - db_22_24k) if db_22_24k is not None else 0.0, 1)
    drop_at_20_5k = round(db_18_20k - db_20_5_22k, 1)

    # 1. Quét ngược phổ tần theo fakeflac để xác định điểm gãy tần số chính xác
    cutoff_hz, cutoff_drop_db = find_spectral_cutoff(power, freqs, sr)

    # 2. Kiểm tra Bit Depth thực tế nếu danh nghĩa là 24-bit
    from core.audiophile_engine import check_bit_depth_purity
    bit_purity_info = check_bit_depth_purity(str(p))
    is_fake_24 = bit_purity_info.get('is_fake_24bit', False)
    has_24bit_bits = (not is_fake_24) if bits > 16 else False

    # 3. Kiểm tra nén Lossy / MP3 giả mạo (áp dụng cho cả 16-bit và 24-bit upsampled)
    is_mp3_320k = bool((cutoff_hz <= 20800 and cutoff_drop_db >= 25.0 and db_18_20k > -55.0) or (db_20_5_22k < -80.0 and drop_at_20_5k > 26.0 and db_18_20k > -55.0))
    is_mp3_low = bool((cutoff_hz <= 19800 and cutoff_drop_db >= 25.0) or (db_18_20k < -65.0 and (db_10_15k - db_18_20k) > 30.0))

    if sr > 48000:
        if is_mp3_320k or is_mp3_low or (db_18_20k < -65 and drop_at_22k > 14):
            verdict = 'FAKE_HIRES_UPSAMPLED'
            badge = '🔴 Fake Hi-Res (Upsize từ MP3)'
            badge_color = '#f43f5e'
            explanation = f'File bị upsample từ file nén MP3 (dải tần bị cắt cụt ở {cutoff_hz}Hz trước khi nội suy lên {sr/1000:.1f}kHz).'
        elif (cutoff_hz <= 22200 and cutoff_drop_db >= 20.0) or (db_22_24k is not None and (db_24_32k < -80 or drop_at_22k > 18)):
            verdict = 'FAKE_HIRES_UPSAMPLED'
            badge = '🔴 Fake Hi-Res (Upsize từ CD)'
            badge_color = '#f43f5e'
            explanation = f'File gán mác {sr/1000:.1f}kHz nhưng dải tần bị chặn đứng ở 22.05kHz (sụt {drop_at_22k}dB), dải siêu âm rỗng ({db_24_32k:.1f}dB).'
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
    elif is_mp3_320k:
        verdict = 'FAKE_LOSSLESS'
        badge = '🔴 Fake Lossless (MP3 320k -> FLAC)'
        badge_color = '#fb7185'
        explanation = f'File FLAC nhưng ruột là MP3 320kbps (dải tần bị chặn gắt ở {cutoff_hz}Hz, sụt {cutoff_drop_db}dB, đặc trưng bộ mã hóa LAME).'
    elif is_mp3_low:
        verdict = 'FAKE_LOSSLESS'
        badge = '🔴 Fake Lossless (MP3 128k-192k -> FLAC)'
        badge_color = '#fb7185'
        explanation = f'File FLAC nhưng ruột là MP3 nén chất lượng thấp (bị cắt tần ở {cutoff_hz}Hz).'
    elif bits > 16:
        if is_fake_24:
            verdict = 'FAKE_24BIT'
            badge = '🔴 Fake 24-bit (Độn bit 0)'
            badge_color = '#f43f5e'
            explanation = 'Vỏ bọc 24-bit nhưng 8 bit cuối toàn số 0 (Zero-padded, thực chất chỉ là 16-bit).'
        else:
            verdict = 'STUDIO_MASTER_24BIT'
            badge = f'🟡 Studio Master {bits}bit/{sr/1000:.1f}k'
            badge_color = '#f59e0b'
            explanation = f'Đạt chuẩn phòng thu {bits}-bit thật với Dynamic Range cao (~144dB).'
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
        'cutoff_hz': cutoff_hz,
        'cutoff_drop_db': cutoff_drop_db,
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

