import json
import math
import subprocess
from pathlib import Path

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
    codec = ''
    sr = None
    bits = None
    channels = None
    dur = None
    readable = False

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
        data = json.loads(res.stdout)
        if 'streams' in data and len(data['streams']) > 0:
            st = data['streams'][0]
            readable = (res.returncode == 0 and int(st.get('sample_rate', 0)) > 0
                        and int(st.get('channels', 0)) > 0)
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
                codec = 'flac'
                readable = audio.info.sample_rate > 0 and audio.info.channels > 0
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
    elif readable and 'dsd' in codec:
        bits = 1
        codec = 'dsd'

    sr = sr if sr is not None and sr > 0 else None
    bits = bits if bits is not None and bits > 0 else None
    channels = channels if channels is not None and channels > 0 else None
    dur = dur if dur is not None and math.isfinite(dur) and dur > 0 else None

    return {
        'is_readable': readable,
        'codec': codec,
        'sample_rate': sr,
        'bit_depth': bits,
        'channels': channels,
        'duration': dur
    }

def format_audio_specs(specs):
    codec = specs.get('codec') or 'Chưa rõ codec'
    bits = specs.get('bit_depth')
    rate = specs.get('sample_rate')
    depth = f'{bits}bit' if bits else '— bit'
    frequency = f'{rate / 1000:.1f}kHz' if rate else '— kHz'
    return f'{codec.upper()} {depth}/{frequency}'


def analyze_audio_file(filepath):
    """Compatibility entry point backed by the evidence-based engine."""
    from core.audio_scoring import analyze
    from core.audio_scoring.legacy import dashboard_fields
    result = dashboard_fields(analyze(filepath))['spectrum']
    result['filepath'] = str(Path(filepath).resolve())
    return result

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

