import os
from pathlib import Path
import mutagen

def get_comment_string(verdict_data):
    v = verdict_data.get('verdict', '')
    sr_khz = verdict_data.get('sample_rate', 44100) / 1000.0
    bits = verdict_data.get('bit_depth', 16)
    
    if v == 'TRUE_HIRES':
        return f"[True Hi-Res {bits}bit/{sr_khz:.1f}kHz - Verified]"
    elif v == 'TRUE_DSD':
        return f"[True DSD Super Audio - Verified]"
    elif v == 'STUDIO_MASTER_24BIT':
        return f"[Studio Master {bits}bit/{sr_khz:.1f}kHz - Verified]"
    elif v == 'FAKE_HIRES_UPSAMPLED':
        return f"[Fake Hi-Res - Upsampled from CD 44.1k]"
    elif v == 'FAKE_LOSSLESS':
        return f"[Fake Lossless - MP3 Transcode]"
    elif v == 'CD_LOSSLESS':
        return f"[CD Lossless 16bit - Verified]"
    else:
        return f"[Lossy Compressed]"

def apply_quality_tag(filepath, verdict_data):
    p = Path(filepath)
    if not p.is_file():
        return False, "File does not exist"
        
    tag_str = get_comment_string(verdict_data)
    ext = p.suffix.lower()
    
    try:
        if ext == '.flac':
            from mutagen.flac import FLAC
            audio = FLAC(p)
            audio['COMMENT'] = tag_str
            audio['HIRES_VERIFIED'] = 'TRUE' if verdict_data.get('verdict') in ('TRUE_HIRES', 'TRUE_DSD', 'STUDIO_MASTER_24BIT') else 'FALSE'
            audio.save()
            return True, f"Tagged FLAC: {tag_str}"
            
        elif ext == '.mp3':
            from mutagen.id3 import ID3, COMM, TXXX
            try:
                audio = ID3(p)
            except Exception:
                from mutagen.mp3 import MP3
                mp3 = MP3(p)
                mp3.add_tags()
                audio = mp3.tags
                
            # Ghi vào frame COMM
            audio.setall('COMM', [COMM(encoding=3, lang='eng', desc='', text=tag_str)])
            audio.setall('TXXX:HIRES_STATUS', [TXXX(encoding=3, desc='HIRES_STATUS', text=tag_str)])
            audio.save()
            return True, f"Tagged MP3: {tag_str}"
            
        elif ext == '.m4a':
            from mutagen.mp4 import MP4
            audio = MP4(p)
            audio['\xa9cmt'] = [tag_str]
            audio.save()
            return True, f"Tagged M4A: {tag_str}"
            
        elif ext == '.dsf':
            from mutagen.dsf import DSF
            audio = DSF(p)
            if hasattr(audio, 'tags') and audio.tags:
                audio.tags['COMM'] = tag_str
                audio.save()
                return True, f"Tagged DSF: {tag_str}"
            return False, "DSF tags not supported"
        else:
            return False, f"Unsupported format: {ext}"
    except Exception as e:
        return False, str(e)
