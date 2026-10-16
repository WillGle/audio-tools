import ast
import base64
from io import BytesIO
import json
import re
import time
import sqlite3
from pathlib import Path
from typing import Dict, Any, Tuple, List
from mediafile import MediaFile, MediaField, StorageStyle, MP3DescStorageStyle, MP4StorageStyle
from mutagen.id3 import ID3, COMM, TXXX
from mutagen.mp4 import MP4FreeForm

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

# Giữ tên tag riêng hiện có; MediaFile chọn cách lưu phù hợp từng định dạng.
for field, tag in [('dynamic_range', 'DYNAMIC_RANGE'), ('dr', 'DR'),
                   ('hires_verified', 'HIRES_VERIFIED'), ('hires_status', 'HIRES_STATUS')]:
    MediaFile.add_field(field, MediaField(
        MP3DescStorageStyle(tag),
        MP4StorageStyle(f'----:com.apple.iTunes:{tag}'),
        StorageStyle(tag)
    ))

TAG_NAMES = {'COMMENT', 'DESCRIPTION', 'DYNAMIC_RANGE', 'DR', 'HIRES_VERIFIED',
             'HIRES_STATUS', 'REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_TRACK_PEAK',
             'R128_TRACK_GAIN', 'ITUNNORM'}
SUPPORTED_TAG_EXTENSIONS = {'.flac', '.mp3', '.m4a', '.dsf'}

def _managed_tag(key):
    if key.startswith('TXXX:'):
        return key[5:].upper() in TAG_NAMES - {'COMMENT', 'DESCRIPTION', 'ITUNNORM'}
    return (key == '\xa9cmt' or key.startswith('COMM:')
            or key.split(':')[-1].upper() in TAG_NAMES)

def _legacy_managed_tag(key, ext):
    name = key.split(':')[-1]
    if ext == '.flac':
        return key.upper() in TAG_NAMES - {'DESCRIPTION', 'HIRES_STATUS', 'ITUNNORM'}
    if ext == '.m4a':
        return key == '\xa9cmt' or name in {'DYNAMIC_RANGE', 'REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_TRACK_PEAK'}
    return key.startswith('COMM:') or (key.startswith('TXXX:') and name in {
        'HIRES_STATUS', 'DYNAMIC_RANGE', 'REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_TRACK_PEAK', 'R128_TRACK_GAIN'
    })

def backup_original_tags(p: Path) -> None:
    """Sao lưu metadata ban đầu của tệp trước khi ghi bất kỳ tag mới nào (để có thể hoàn tác)."""
    conn = get_backup_db()
    try:
        key = str(p.resolve())
        # Luôn giữ lại bản sao lưu nguyên bản đầu tiên.
        row = conn.execute("SELECT original_data FROM tag_backups WHERE filepath = ?", (key,)).fetchone()
        if row:
            data = json.loads(row[0])
            if data.get('snapshot_version') == 2:
                return
        audio = MediaFile(p)
        tags = audio.mgfile.tags
        if row:
            # Nâng bản sao lưu cũ trong bộ nhớ, giữ cả các tag mà mã cũ chưa chạm tới.
            for name in list(tags.keys()):
                if _legacy_managed_tag(name, p.suffix.lower()):
                    del tags[name]
            _restore_legacy_tags(audio, data, p.suffix.lower())
        if isinstance(tags, ID3):
            original = ID3()
            for name in tags:
                if _managed_tag(name):
                    original.add(tags[name])
            buf = BytesIO()
            original.save(buf)
            raw_data = {'id3': base64.b64encode(buf.getvalue()).decode('ascii')}
        else:
            raw_data = {'tags': {
                name: [({'bytes': base64.b64encode(v).decode('ascii'),
                         'format': int(v.dataformat)} if isinstance(v, MP4FreeForm) else v)
                       for v in tags[name]]
                for name in tags.keys() if _managed_tag(name)
            }}
        raw_data['snapshot_version'] = 2
        encoded = json.dumps(raw_data, ensure_ascii=False)
        if row:
            conn.execute("UPDATE tag_backups SET original_data = ? WHERE filepath = ? AND original_data = ?",
                         (encoded, key, row[0]))
        else:
            conn.execute(
                "INSERT OR IGNORE INTO tag_backups (filepath, timestamp, ext, original_data) VALUES (?, ?, ?, ?)",
                (key, time.time(), p.suffix.lower(), encoded)
            )
        conn.commit()
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
        
    return f"[{' | '.join(parts)}]" if parts else "[Audio diagnostics]"

def apply_audiophile_tags(filepath: str, audit_data: Dict[str, Any]) -> Tuple[bool, str]:
    """
    Ghi metadata Audiophile đầy đủ:
    - Tự động sao lưu metadata gốc trước khi ghi
    - Dynamic Range (DYNAMIC_RANGE / DR)
    - ReplayGain 2.0 (REPLAYGAIN_TRACK_GAIN, REPLAYGAIN_TRACK_PEAK)
    - EBU R128 (R128_TRACK_GAIN, số nguyên Q7.8)
    - Quality Comment & Status
    """
    p = Path(filepath)
    if not p.is_file():
        return False, f"File không tồn tại: {filepath}"
    if p.suffix.lower() not in SUPPORTED_TAG_EXTENSIONS:
        return False, f"Định dạng chưa hỗ trợ gắn tag: {p.suffix.lower()}"

    dr_score = audit_data.get('dynamic_range', {}).get('dr_score', 0)
    loudness = audit_data.get('loudness', {})
    rg_gain = loudness.get('replaygain_track_gain', '')
    tag_comment = get_audiophile_comment(audit_data)
    if loudness.get('error'):
        return False, loudness['error']

    try:
        audio = MediaFile(p)
        # Nếu sao lưu thất bại, không ghi đè metadata gốc.
        backup_original_tags(p)
        audio.comments = tag_comment
        audio.hires_verified = 'UNVERIFIED'  # Format grouping cannot verify source provenance.
        if p.suffix.lower() in ('.mp3', '.dsf'):
            audio.hires_status = tag_comment
        if dr_score > 0 and not audit_data.get('dynamic_range', {}).get('is_estimate'):
            audio.dynamic_range = f"DR{dr_score}"
            audio.dr = str(dr_score)
        if rg_gain:
            audio.rg_track_gain = float(rg_gain.removesuffix(' dB'))
            audio.rg_track_peak = float(loudness['replaygain_track_peak'])
            r128_gain = loudness.get('r128_track_gain')
            if r128_gain:
                audio.r128_track_gain = float(r128_gain.removesuffix(' dB'))
        audio.save()
        return True, f"Đã ghi Audiophile Tags {p.suffix[1:].upper()}: DR{dr_score} | Gain: {rg_gain}"
    except Exception as e:
        return False, str(e)

def _restore_legacy_tags(audio, data, ext):
    # Các bản sao lưu cũ vẫn dùng được sau khi chuyển sang MediaFile.
    tags = audio.mgfile.tags
    if isinstance(tags, ID3):
        comments = data.get('COMM', [])
        if isinstance(comments, str):
            comments = [{'text': [comments]}]
        for item in comments:
            tags.add(COMM(encoding=3, lang='eng', desc=item.get('desc', ''), text=item.get('text', [])))
        for name, values in data.items():
            if name.startswith('TXXX:'):
                tags.add(TXXX(encoding=3, desc=name[5:], text=values))
        if ext == '.dsf' and data.get('DYNAMIC_RANGE'):
            audio.dynamic_range = data['DYNAMIC_RANGE']
    else:
        for name, values in data.items():
            if ext == '.m4a' and name.startswith('----:'):
                # Mã cũ lưu repr của giá trị MP4; không đoán nếu không đọc được.
                if isinstance(values, str):
                    literal = re.sub(r'<AtomDataType\.\w+: (\d+)>', r'\1', values)
                    tree = ast.parse(literal, mode='eval').body
                    if isinstance(tree, ast.List):
                        values = []
                        for item in tree.elts:
                            if isinstance(item, ast.Call) and isinstance(item.func, ast.Name) and item.func.id == 'MP4FreeForm' and not item.keywords:
                                values.append(MP4FreeForm(*(ast.literal_eval(arg) for arg in item.args)))
                            else:
                                values.append(ast.literal_eval(item))
                    else:
                        values = ast.literal_eval(tree)
                if isinstance(values, bytes):
                    values = [values]
            tags[name] = values

def revert_audiophile_tags(filepath: str) -> Tuple[bool, str]:
    """
    Hoàn tác (Undo) và khôi phục metadata ban đầu của tệp:
    - Khôi phục các tag đã ghi từ cơ sở dữ liệu sao lưu
    - Hoặc gỡ tag Audiophile nếu không có sao lưu
    """
    p = Path(filepath)
    if not p.is_file():
        return False, f"File không tồn tại: {filepath}"
    if p.suffix.lower() not in SUPPORTED_TAG_EXTENSIONS:
        return False, f"Định dạng chưa hỗ trợ gắn tag: {p.suffix.lower()}"

    key = str(p.resolve())
    conn = get_backup_db()
    try:
        row = conn.execute("SELECT original_data FROM tag_backups WHERE filepath = ?", (key,)).fetchone()
        data = json.loads(row[0]) if row else {}
        audio = MediaFile(p)
        tags = audio.mgfile.tags
        for name in list(tags.keys()):
            managed = _legacy_managed_tag(name, p.suffix.lower()) if row and 'snapshot_version' not in data else _managed_tag(name)
            if managed:
                if not row and (name == '\xa9cmt' or name.startswith('COMM:') or name.upper() in {'COMMENT', 'DESCRIPTION'}):
                    if not audio.comments.startswith('['):
                        continue
                del tags[name]
        if data.get('snapshot_version') == 2:
            if 'id3' in data:
                original = ID3(BytesIO(base64.b64decode(data['id3'])))
                for frame in original.values():
                    tags.add(frame)
            else:
                for name, values in data['tags'].items():
                    tags[name] = [MP4FreeForm(base64.b64decode(v['bytes']), dataformat=v['format'])
                                  if isinstance(v, dict) else v for v in values]
        elif row:
            _restore_legacy_tags(audio, data, p.suffix.lower())
        audio.save()

        # Chỉ xóa bản sao lưu sau khi đã khôi phục thành công.
        if row:
            conn.execute("DELETE FROM tag_backups WHERE filepath = ?", (key,))
            conn.commit()
        msg = "Đã hoàn tác và khôi phục metadata gốc của tệp thành công!" if row else "Đã gỡ bỏ toàn bộ tag Audiophile khỏi tệp thành công!"
        return True, msg
    except Exception as e:
        return False, f"Lỗi hoàn tác tag: {str(e)}"
    finally:
        conn.close()

def rollback_all_audiophile_tags(root_dir=None) -> Tuple[int, List[str]]:
    """Hoàn tác toàn bộ các tệp đã được gắn tag trong hệ thống."""
    conn = get_backup_db()
    c = conn.cursor()
    c.execute("SELECT filepath FROM tag_backups")
    rows = c.fetchall()
    conn.close()

    success_count = 0
    reverted_paths = []

    for (fp,) in rows:
        if root_dir is not None:
            from core.paths import vault_path
            try:
                vault_path(root_dir, fp)
            except (ValueError, OSError):
                continue
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
