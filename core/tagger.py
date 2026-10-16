import os
import json
import time
import sqlite3
from pathlib import Path
from typing import Dict, Any, Tuple, List, Optional

def get_backup_db() -> sqlite3.Connection:
    cache_dir = Path(__file__).resolve().parent.parent / 'cache'
    cache_dir.mkdir(parents=True, exist_ok=True)
    db_path = cache_dir / 'tag_backups.sqlite'
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute("""
    CREATE TABLE IF NOT EXISTS tag_backups (
        filepath TEXT PRIMARY KEY,
        timestamp REAL,
        ext TEXT,
        original_data TEXT
    )
    """)
    conn.commit()
    return conn

def backup_original_tags(p: Path) -> None:
    """Sao lưu metadata ban đầu của tệp trước khi ghi bất kỳ tag mới nào (để có thể hoàn tác)."""
    conn = get_backup_db()
    c = conn.cursor()
    
    # Kiểm tra xem đã có bản sao lưu trước đó chưa (luôn giữ lại bản sao lưu nguyên bản đầu tiên)
    key = str(p.resolve())
    c.execute("SELECT 1 FROM tag_backups WHERE filepath = ?", (key,))
    if c.fetchone():
        conn.close()
        return

    ext = p.suffix.lower()
    raw_data: Dict[str, Any] = {}

    try:
        if ext == '.flac':
            from mutagen.flac import FLAC
            audio = FLAC(p)
            for k in ['COMMENT', 'HIRES_VERIFIED', 'DYNAMIC_RANGE', 'DR', 'REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_TRACK_PEAK', 'R128_TRACK_GAIN']:
                if k in audio:
                    raw_data[k] = list(audio[k])

        elif ext == '.mp3':
            from mutagen.id3 import ID3
            try:
                audio = ID3(p)
                comm_list = []
                for comm in audio.getall('COMM'):
                    comm_list.append({'desc': comm.desc, 'text': list(comm.text)})
                if comm_list:
                    raw_data['COMM'] = comm_list
                for txxx in audio.getall('TXXX'):
                    if txxx.desc in ('HIRES_STATUS', 'DYNAMIC_RANGE', 'REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_TRACK_PEAK', 'R128_TRACK_GAIN'):
                        raw_data[f'TXXX:{txxx.desc}'] = list(txxx.text)
            except Exception:
                pass

        elif ext == '.m4a':
            from mutagen.mp4 import MP4
            try:
                audio = MP4(p)
                if '\xa9cmt' in audio:
                    raw_data['\xa9cmt'] = audio['\xa9cmt']
                for k in audio.keys():
                    if 'DYNAMIC_RANGE' in k or 'REPLAYGAIN' in k:
                        val = audio[k]
                        raw_data[k] = val.decode('utf-8', errors='ignore') if isinstance(val, bytes) else str(val)
            except Exception:
                pass

        elif ext == '.dsf':
            from mutagen.dsf import DSF
            try:
                audio = DSF(p)
                if hasattr(audio, 'tags') and audio.tags:
                    if 'COMM' in audio.tags:
                        raw_data['COMM'] = str(audio.tags['COMM'])
                    if 'DYNAMIC_RANGE' in audio.tags:
                        raw_data['DYNAMIC_RANGE'] = str(audio.tags['DYNAMIC_RANGE'])
            except Exception:
                pass

        c.execute(
            "INSERT OR IGNORE INTO tag_backups (filepath, timestamp, ext, original_data) VALUES (?, ?, ?, ?)",
            (key, time.time(), ext, json.dumps(raw_data, ensure_ascii=False))
        )
        conn.commit()
    except Exception as e:
        print(f"Lỗi khi sao lưu metadata {p}: {e}")
    finally:
        conn.close()

def get_audiophile_comment(audit_data: Dict[str, Any]) -> str:
    dr = audit_data.get('dynamic_range', {})
    dr_badge = dr.get('dr_badge', '')
    
    tier = audit_data.get('vault_tier', {})
    tier_badge = tier.get('badge', '')
    
    rg = audit_data.get('loudness', {})
    rg_gain = rg.get('replaygain_track_gain', '')
    
    parts = []
    if dr_badge:
        parts.append(dr_badge)
    if tier_badge:
        # Lọc bỏ icon
        clean_tier = tier_badge.replace('🟢 ', '').replace('🔵 ', '').replace('🔴 ', '').replace('⚪ ', '')
        parts.append(clean_tier)
    if rg_gain:
        parts.append(f"RG {rg_gain}")
        
    return f"[{' | '.join(parts)}]" if parts else "[Audiophile Verified]"

def apply_audiophile_tags(filepath: str, audit_data: Dict[str, Any]) -> Tuple[bool, str]:
    """
    Ghi metadata Audiophile đầy đủ:
    - Tự động sao lưu metadata gốc trước khi ghi (cho phép hoàn tác 100%)
    - Dynamic Range (DYNAMIC_RANGE / DR)
    - ReplayGain 2.0 (REPLAYGAIN_TRACK_GAIN, REPLAYGAIN_TRACK_PEAK)
    - EBU R128 (R128_TRACK_GAIN)
    - Quality Comment & Status
    """
    p = Path(filepath)
    if not p.is_file():
        return False, f"File không tồn tại: {filepath}"

    # 1. Tự động sao lưu metadata gốc trước khi thay đổi
    backup_original_tags(p)

    ext = p.suffix.lower()
    tag_comment = get_audiophile_comment(audit_data)
    
    dr = audit_data.get('dynamic_range', {})
    dr_score = dr.get('dr_score', 0)
    dr_str = f"DR{dr_score}" if dr_score > 0 else ""

    loudness = audit_data.get('loudness', {})
    rg_gain = loudness.get('replaygain_track_gain', '')
    rg_peak = str(loudness.get('replaygain_track_peak', ''))
    r128_gain = loudness.get('r128_track_gain', '')

    tier = audit_data.get('vault_tier', {})
    is_hires = tier.get('tier_id') == '01_hires_dsd'

    try:
        if ext == '.flac':
            from mutagen.flac import FLAC
            audio = FLAC(p)
            audio['COMMENT'] = tag_comment
            audio['HIRES_VERIFIED'] = 'TRUE' if is_hires else 'FALSE'
            if dr_str:
                audio['DYNAMIC_RANGE'] = dr_str
                audio['DR'] = str(dr_score)
            if rg_gain:
                audio['REPLAYGAIN_TRACK_GAIN'] = rg_gain
                audio['REPLAYGAIN_TRACK_PEAK'] = rg_peak
                audio['R128_TRACK_GAIN'] = r128_gain
            audio.save()
            return True, f"Đã ghi Audiophile Tags FLAC: {dr_str} | Gain: {rg_gain}"

        elif ext == '.mp3':
            from mutagen.id3 import ID3, COMM, TXXX
            try:
                audio = ID3(p)
            except Exception:
                from mutagen.mp3 import MP3
                mp3 = MP3(p)
                mp3.add_tags()
                audio = mp3.tags

            audio.setall('COMM', [COMM(encoding=3, lang='eng', desc='', text=tag_comment)])
            audio.setall('TXXX:HIRES_STATUS', [TXXX(encoding=3, desc='HIRES_STATUS', text=tag_comment)])
            if dr_str:
                audio.setall('TXXX:DYNAMIC_RANGE', [TXXX(encoding=3, desc='DYNAMIC_RANGE', text=dr_str)])
            if rg_gain:
                audio.setall('TXXX:REPLAYGAIN_TRACK_GAIN', [TXXX(encoding=3, desc='REPLAYGAIN_TRACK_GAIN', text=rg_gain)])
                audio.setall('TXXX:REPLAYGAIN_TRACK_PEAK', [TXXX(encoding=3, desc='REPLAYGAIN_TRACK_PEAK', text=rg_peak)])
                audio.setall('TXXX:R128_TRACK_GAIN', [TXXX(encoding=3, desc='R128_TRACK_GAIN', text=r128_gain)])
            audio.save()
            return True, f"Đã ghi Audiophile Tags MP3: {dr_str} | Gain: {rg_gain}"

        elif ext == '.m4a':
            from mutagen.mp4 import MP4
            audio = MP4(p)
            audio['\xa9cmt'] = [tag_comment]
            if dr_str:
                audio['----:com.apple.iTunes:DYNAMIC_RANGE'] = dr_str.encode('utf-8')
            if rg_gain:
                audio['----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN'] = rg_gain.encode('utf-8')
                audio['----:com.apple.iTunes:REPLAYGAIN_TRACK_PEAK'] = rg_peak.encode('utf-8')
            audio.save()
            return True, f"Đã ghi Audiophile Tags M4A: {dr_str} | Gain: {rg_gain}"

        elif ext == '.dsf':
            from mutagen.dsf import DSF
            audio = DSF(p)
            if hasattr(audio, 'tags') and audio.tags:
                audio.tags['COMM'] = tag_comment
                if dr_str:
                    audio.tags['DYNAMIC_RANGE'] = dr_str
                audio.save()
                return True, f"Đã ghi Audiophile Tags DSF: {dr_str}"
            return False, "Định dạng tag DSF không hỗ trợ ghi thêm trường mở rộng"

        else:
            return False, f"Định dạng chưa hỗ trợ gắn tag: {ext}"

    except Exception as e:
        return False, str(e)

def revert_audiophile_tags(filepath: str) -> Tuple[bool, str]:
    """
    Hoàn tác (Undo) và khôi phục metadata ban đầu của tệp:
    - Khôi phục COMMENT/tag gốc từ cơ sở dữ liệu sao lưu
    - Hoặc gỡ sạch toàn bộ tag Audiophile nếu không có sao lưu
    """
    p = Path(filepath)
    if not p.is_file():
        return False, f"File không tồn tại: {filepath}"

    ext = p.suffix.lower()
    key = str(p.resolve())
    
    # 1. Tìm bản sao lưu
    conn = get_backup_db()
    c = conn.cursor()
    c.execute("SELECT original_data FROM tag_backups WHERE filepath = ?", (key,))
    row = c.fetchone()
    
    backup_data = {}
    has_backup = False
    if row and row[0]:
        try:
            backup_data = json.loads(row[0])
            has_backup = True
        except Exception:
            pass

    try:
        if ext == '.flac':
            from mutagen.flac import FLAC
            audio = FLAC(p)
            for k in ['DYNAMIC_RANGE', 'DR', 'REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_TRACK_PEAK', 'R128_TRACK_GAIN', 'HIRES_VERIFIED']:
                if k in audio:
                    del audio[k]
            
            orig_comm = backup_data.get('COMMENT')
            if orig_comm is not None:
                if orig_comm:
                    audio['COMMENT'] = orig_comm
                elif 'COMMENT' in audio:
                    del audio['COMMENT']
            elif 'COMMENT' in audio:
                # Xóa comment nếu có chứa tag của tool
                comm_str = str(audio['COMMENT'][0]) if audio['COMMENT'] else ''
                if '[' in comm_str and ']' in comm_str:
                    del audio['COMMENT']
            audio.save()

        elif ext == '.mp3':
            from mutagen.id3 import ID3, COMM
            try:
                audio = ID3(p)
                for k in ['TXXX:HIRES_STATUS', 'TXXX:DYNAMIC_RANGE', 'TXXX:REPLAYGAIN_TRACK_GAIN', 'TXXX:REPLAYGAIN_TRACK_PEAK', 'TXXX:R128_TRACK_GAIN']:
                    if k in audio:
                        del audio[k]

                orig_comm = backup_data.get('COMM')
                if orig_comm is not None:
                    audio.delall('COMM')
                    for item in orig_comm:
                        audio.add(COMM(encoding=3, lang='eng', desc=item.get('desc', ''), text=item.get('text', [])))
                else:
                    audio.delall('COMM')
                audio.save()
            except Exception:
                pass

        elif ext == '.m4a':
            from mutagen.mp4 import MP4
            audio = MP4(p)
            keys_to_del = [k for k in audio.keys() if 'DYNAMIC_RANGE' in k or 'REPLAYGAIN' in k]
            for k in keys_to_del:
                del audio[k]

            if '\xa9cmt' in backup_data:
                orig_cmt = backup_data['\xa9cmt']
                if orig_cmt:
                    audio['\xa9cmt'] = orig_cmt
                elif '\xa9cmt' in audio:
                    del audio['\xa9cmt']
            elif '\xa9cmt' in audio:
                del audio['\xa9cmt']
            audio.save()

        elif ext == '.dsf':
            from mutagen.dsf import DSF
            audio = DSF(p)
            if hasattr(audio, 'tags') and audio.tags:
                if 'DYNAMIC_RANGE' in audio.tags:
                    del audio.tags['DYNAMIC_RANGE']
                if 'COMM' in backup_data:
                    orig_comm = backup_data['COMM']
                    if orig_comm:
                        audio.tags['COMM'] = orig_comm
                    elif 'COMM' in audio.tags:
                        del audio.tags['COMM']
                elif 'COMM' in audio.tags:
                    del audio.tags['COMM']
                audio.save()

        # Xóa bản sao lưu sau khi đã khôi phục thành công
        if has_backup:
            c.execute("DELETE FROM tag_backups WHERE filepath = ?", (key,))
            conn.commit()

        msg = "Đã hoàn tác và khôi phục metadata gốc của tệp thành công!" if has_backup else "Đã gỡ bỏ toàn bộ tag Audiophile khỏi tệp thành công!"
        return True, msg

    except Exception as e:
        return False, f"Lỗi hoàn tác tag: {str(e)}"
    finally:
        conn.close()

def rollback_all_audiophile_tags() -> Tuple[int, List[str]]:
    """Hoàn tác toàn bộ các tệp đã được gắn tag trong hệ thống."""
    conn = get_backup_db()
    c = conn.cursor()
    c.execute("SELECT filepath FROM tag_backups")
    rows = c.fetchall()
    conn.close()

    success_count = 0
    reverted_paths = []

    for (fp,) in rows:
        ok, _ = revert_audiophile_tags(fp)
        if ok:
            success_count += 1
            reverted_paths.append(fp)

    return success_count, reverted_paths

# Backward compatibility alias
def apply_quality_tag(filepath, verdict_data):
    mock_audit = {
        'dynamic_range': {'dr_score': 0, 'dr_badge': ''},
        'vault_tier': {'badge': verdict_data.get('verdict', ''), 'tier_id': '02_cd_lossless'},
        'loudness': {}
    }
    return apply_audiophile_tags(filepath, mock_audit)
