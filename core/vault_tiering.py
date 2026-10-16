import os
import sys
import json
import shutil
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from core.paths import vault_path
from core.analyzer import get_audio_specs
from pathlib import Path
from typing import Dict, Any, List, Optional

AUDIO_EXTENSIONS = {'.flac', '.wav', '.dsf', '.dff', '.m4a', '.mp3', '.ape', '.ogg', '.wma', '.aac', '.opus', '.aif', '.aiff'}

TIER_NAMES = {
    'tier_1': '01_DSD & Hi-Res (>24/96k)',
    'tier_2': '02_Lossless CD (16/44.1k)',
    'tier_3': '03_Quarantine (Fake Hi-Res, MP3, File Lỗi)'
}

def clean_name(s: str) -> str:
    import re
    if not s:
        return 'Unknown'
    s = re.sub(r'[/\\:*?"<>|]', '_', str(s))
    s = re.sub(r'\s+', ' ', s)
    return s.strip() if s.strip() not in {'.', '..'} else 'Unknown'

def scan_and_generate_tiering_plan(vault_dir: Path, tools_dir: Path) -> Dict[str, Any]:
    """
    Tạo kế hoạch phân bổ 3 cấp Vault Tiering cho toàn bộ thư viện.
    Tận dụng cache hires_verdicts.json và organize_plan.json nếu có.
    """
    vault_dir = Path(vault_dir).resolve()
    cache_dir = tools_dir / 'cache'
    verdicts_file = cache_dir / 'hires_verdicts.json'
    plan_file = tools_dir / 'organize_plan.json'

    hires_verdicts = {}
    if verdicts_file.exists():
        try:
            with open(verdicts_file, encoding='utf-8') as f:
                raw = json.load(f)
                for item in raw:
                    from core.audio_scoring.legacy import cached_record_current
                    if cached_record_current(item, Path(item.get('filepath', ''))):
                        hires_verdicts[item.get('filepath', '')] = item
        except Exception:
            pass

    existing_plan_items = []
    if plan_file.exists():
        try:
            with open(plan_file, encoding='utf-8') as f:
                existing_plan_items = json.load(f)
        except Exception:
            pass

    items_map = {it['original_path']: it for it in existing_plan_items}

    # Quét tất cả file âm thanh trong vault
    all_files = []
    for root, dirs, files in os.walk(vault_dir):
        # Bỏ qua thư mục archive hoặc thư mục tier đã phân loại
        if '_Duplicates_Archive' in root or '_Vault_3_Tier' in root or '.git' in root:
            continue
        for file in files:
            p = Path(root) / file
            if p.suffix.lower() in AUDIO_EXTENSIONS:
                if not p.resolve().is_relative_to(vault_dir):
                    continue
                rel = str(p.relative_to(vault_dir))
                all_files.append((p, rel))

    tier_1_items = []
    tier_2_items = []
    tier_3_items = []

    def classify_file(file_pair):
        full_path, rel_path = file_pair
        ext = full_path.suffix.lower()
        size_bytes = full_path.stat().st_size
        v_info = hires_verdicts.get(str(full_path), {})
        verdict = v_info.get('verdict', '')

        # Lấy metadata cơ bản từ existing plan hoặc file
        meta = items_map.get(rel_path, {})
        artist = meta.get('artist') or clean_name(full_path.parent.name)
        album = meta.get('album') or clean_name(full_path.parent.name)
        title = meta.get('title') or clean_name(full_path.stem)
        audio = get_audio_specs(str(full_path))
        codec = audio.get('codec', '').lower()
        specs = f"{codec.upper()} {audio['bit_depth']}bit/{audio['sample_rate']/1000:.1f}kHz"

        # 1. Tiêu chí vào Tier 3: Quarantine (Fake Hi-Res, MP3, Fake 24-bit, File Lỗi)
        if not audio.get('is_readable'):
            target_tier = 'tier_3'
            reason = 'Không đọc được thông tin âm thanh'
            sub_folder = 'Unverified'
        elif codec in ('mp3', 'aac', 'vorbis', 'opus', 'wmav1', 'wmav2', 'wmapro'):
            target_tier = 'tier_3'
            reason = f'Nhạc nén tổn hao Lossy ({ext[1:].upper()})'
            sub_folder = 'Lossy_Audio'
        elif verdict in ('FAKE_HIRES_UPSAMPLED', 'FAKE_LOSSLESS', 'FAKE_24BIT', 'DSD_CONVERTED_FROM_PCM'):
            target_tier = 'tier_3'
            reason = f'Phát hiện chất lượng giả mạo ({verdict})'
            sub_folder = 'Fake_Or_Upsampled'

        # 2. Tiêu chí vào Tier 1: DSD & Hi-Res (>24/96k)
        elif 'dsd' in codec or verdict == 'TRUE_DSD':
            target_tier = 'tier_1'
            reason = 'Định dạng DSD; nguồn master chưa xác thực'
            sub_folder = 'DSD_SACD'
        elif audio['sample_rate'] >= 88200 or verdict == 'TRUE_HIRES':
            target_tier = 'tier_1'
            reason = 'PCM sample rate cao; xem audit để xác thực chất lượng'
            sub_folder = 'PCM_HiRes_96k_Plus'

        # 3. Tiêu chí vào Tier 2: Lossless CD (16/44.1k hoặc Studio Master 24/44.1-48k)
        elif codec in ('flac', 'alac', 'ape', 'wmalossless') or codec.startswith('pcm_'):
            target_tier = 'tier_2'
            reason = 'Định dạng lossless; chưa kiểm tra bit-perfect'
            sub_folder = 'CD_Lossless'
        else:
            target_tier = 'tier_3'
            reason = 'Định dạng chưa xác thực'
            sub_folder = 'Unverified'

        dest_rel = f"{TIER_NAMES[target_tier]}/{clean_name(artist)}/{clean_name(album)}/{full_path.name}"

        item_entry = {
            'original_path': rel_path,
            'dest_path': dest_rel,
            'tier': target_tier,
            'tier_name': TIER_NAMES[target_tier],
            'reason': reason,
            'size_bytes': size_bytes,
            'artist': artist,
            'album': album,
            'title': title,
            'specs': specs
        }

        return target_tier, item_entry


    # ffprobe is process-bound and can block on damaged files; bounded workers keep
    # a large library scan responsive without spawning one process per file.
    with ThreadPoolExecutor(max_workers=min(8, max(1, (os.cpu_count() or 2)))) as pool:
        for target_tier, item_entry in pool.map(classify_file, all_files):
            if target_tier == 'tier_1':
                tier_1_items.append(item_entry)
            elif target_tier == 'tier_2':
                tier_2_items.append(item_entry)
            else:
                tier_3_items.append(item_entry)

    total_files = len(tier_1_items) + len(tier_2_items) + len(tier_3_items)
    total_size = sum(x['size_bytes'] for x in tier_1_items + tier_2_items + tier_3_items)

    return {
        'total_files': total_files,
        'total_size_gb': round(total_size / (1024**3), 2),
        'summary': {
            'tier_1': {
                'name': TIER_NAMES['tier_1'],
                'count': len(tier_1_items),
                'size_gb': round(sum(x['size_bytes'] for x in tier_1_items) / (1024**3), 2),
                'sample': tier_1_items[:10]
            },
            'tier_2': {
                'name': TIER_NAMES['tier_2'],
                'count': len(tier_2_items),
                'size_gb': round(sum(x['size_bytes'] for x in tier_2_items) / (1024**3), 2),
                'sample': tier_2_items[:10]
            },
            'tier_3': {
                'name': TIER_NAMES['tier_3'],
                'count': len(tier_3_items),
                'size_gb': round(sum(x['size_bytes'] for x in tier_3_items) / (1024**3), 2),
                'sample': tier_3_items[:10]
            }
        },
        'items': tier_1_items + tier_2_items + tier_3_items
    }

_tiering_lock = Lock()


def _write_rollback(path, records):
    temp = path.with_suffix('.tmp')
    with open(temp, 'w', encoding='utf-8') as f:
        json.dump(records, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    temp.replace(path)


def execute_tiering(vault_dir, plan_items, mode='symlink', *, rollback_name='.vault_tiering_rollback.json'):
    with _tiering_lock:
        return _execute_tiering(vault_dir, plan_items, mode, rollback_name)


def _execute_tiering(vault_dir, plan_items, mode, rollback_name):
    if mode not in ('symlink', 'move'):
        raise ValueError('Chế độ phải là symlink hoặc move')
    vault_dir = Path(vault_dir).resolve()
    target_base = vault_dir if mode == 'move' else vault_path(vault_dir, '_Vault_3_Tier_Symlinks')
    rollback_file = vault_path(vault_dir, rollback_name)
    records = json.loads(rollback_file.read_text()) if rollback_file.exists() else []
    if not isinstance(records, list):
        raise ValueError('Tệp rollback không hợp lệ')
    success_count = 0
    errors = []
    for item in plan_items:
        try:
            src = vault_path(vault_dir, item['original_path'])
            dst = vault_path(target_base, item['dest_path'])
            if not src.is_file() or src.suffix.lower() not in AUDIO_EXTENSIONS:
                raise ValueError('Không tìm thấy tệp âm thanh')
            if mode == 'move' and (vault_dir / item['original_path']).is_symlink():
                raise ValueError('Không di chuyển symlink nguồn; hãy chọn tệp gốc')
            if dst.suffix.lower() != src.suffix.lower():
                raise ValueError('Đích phải giữ định dạng âm thanh của nguồn')
            if dst == src:
                raise ValueError('Nguồn và đích trùng nhau')
            if dst.exists() or dst.is_symlink():
                raise FileExistsError(f'Đích đã tồn tại: {dst}')
            dst.parent.mkdir(parents=True, exist_ok=True)
            if mode == 'symlink':
                dst.symlink_to(src)
            else:
                # Ghi ý định trước khi di chuyển để không mất lịch sử khi bị ngắt.
                records.append({'original': str(src), 'moved_to': str(dst)})
                _write_rollback(rollback_file, records)
                shutil.move(src, dst)
            success_count += 1
        except Exception as exc:
            errors.append(f"{item.get('original_path', '?')}: {exc}")
    return {
        'success': not errors, 'mode': mode,
        'success_count': success_count, 'error_count': len(errors),
        'errors': errors, 'target_base': str(target_base),
        'message': f'Đã xử lý {success_count} tệp; {len(errors)} lỗi.'
    }


def rollback_vault_tiering(vault_dir, *, rollback_name='.vault_tiering_rollback.json'):
    with _tiering_lock:
        return _rollback_vault_tiering(vault_dir, rollback_name)


def _rollback_vault_tiering(vault_dir, rollback_name):
    vault_dir = Path(vault_dir).resolve()
    rollback_file = vault_path(vault_dir, rollback_name)
    if not rollback_file.exists():
        return {'success': False, 'message': f'Không tìm thấy nhật ký hoàn tác {rollback_name}'}
    records = json.loads(rollback_file.read_text())
    if not isinstance(records, list):
        raise ValueError('Tệp rollback không hợp lệ')
    restored = 0
    errors = []
    remaining = []
    for record in reversed(records):
        try:
            src = vault_path(vault_dir, record['moved_to'])
            dst = vault_path(vault_dir, record['original'])
            if not src.exists() and dst.is_file():
                continue  # Ý định đã lưu nhưng thao tác move chưa chạy.
            if not src.is_file():
                raise FileNotFoundError(f'Không tìm thấy {src}')
            if dst.exists() or dst.is_symlink():
                raise FileExistsError(f'Đích đã tồn tại: {dst}')
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(src, dst)
            restored += 1
        except Exception as exc:
            remaining.append(record)
            errors.append(str(exc))
    if remaining:
        _write_rollback(rollback_file, list(reversed(remaining)))
    else:
        rollback_file.unlink()
    return {
        'success': not errors, 'restored_count': restored, 'errors': errors,
        'message': f'Đã khôi phục {restored} tệp; còn {len(remaining)} tệp chưa khôi phục.'
    }
