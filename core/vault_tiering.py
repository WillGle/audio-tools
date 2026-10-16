import os
import sys
import json
import shutil
from pathlib import Path
from typing import Dict, Any, List, Optional

AUDIO_EXTENSIONS = {'.flac', '.wav', '.dsf', '.dff', '.m4a', '.mp3', '.ape', '.ogg', '.wma', '.aac'}

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
    return s.strip()

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
                rel = str(p.relative_to(vault_dir))
                all_files.append((p, rel))

    tier_1_items = []
    tier_2_items = []
    tier_3_items = []

    for full_path, rel_path in all_files:
        ext = full_path.suffix.lower()
        size_bytes = full_path.stat().st_size
        v_info = hires_verdicts.get(str(full_path), {})
        verdict = v_info.get('verdict', '')

        # Lấy metadata cơ bản từ existing plan hoặc file
        meta = items_map.get(rel_path, {})
        artist = meta.get('artist') or clean_name(full_path.parent.name)
        album = meta.get('album') or clean_name(full_path.parent.name)
        title = meta.get('title') or clean_name(full_path.stem)
        specs = meta.get('specs') or ''

        # 1. Tiêu chí vào Tier 3: Quarantine (Fake Hi-Res, MP3, Fake 24-bit, File Lỗi)
        if ext in ('.mp3', '.m4a', '.aac', '.ogg', '.wma'):
            target_tier = 'tier_3'
            reason = f'Nhạc nén tổn hao Lossy ({ext[1:].upper()})'
            sub_folder = 'Lossy_Audio'
        elif verdict in ('FAKE_HIRES_UPSAMPLED', 'FAKE_LOSSLESS', 'FAKE_24BIT', 'DSD_CONVERTED_FROM_PCM'):
            target_tier = 'tier_3'
            reason = f'Phát hiện chất lượng giả mạo ({verdict})'
            sub_folder = 'Fake_Or_Upsampled'
        elif 'Upsampled' in meta.get('tier', ''):
            target_tier = 'tier_3'
            reason = 'Upsampled Fake Hi-Res từ bản 44.1kHz'
            sub_folder = 'Fake_Or_Upsampled'

        # 2. Tiêu chí vào Tier 1: DSD & Hi-Res (>24/96k)
        elif ext in ('.dsf', '.dff') or 'DSD' in specs or verdict == 'TRUE_DSD':
            target_tier = 'tier_1'
            reason = 'Native DSD / SACD Super Audio'
            sub_folder = 'DSD_SACD'
        elif '24bit/96' in specs or '24bit/192' in specs or '24bit/88' in specs or '24bit/176' in specs or verdict == 'TRUE_HIRES':
            target_tier = 'tier_1'
            reason = 'True Hi-Res Audio (24-bit / 96k+)'
            sub_folder = 'PCM_HiRes_96k_Plus'

        # 3. Tiêu chí vào Tier 2: Lossless CD (16/44.1k hoặc Studio Master 24/44.1-48k)
        elif ext in ('.flac', '.wav', '.ape'):
            target_tier = 'tier_2'
            reason = 'Bit-Perfect Lossless CD / Studio Master'
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

def execute_tiering(
    vault_dir: Path,
    plan_items: List[Dict[str, Any]],
    mode: str = 'symlink'
) -> Dict[str, Any]:
    """
    Thực thi xuất cấu trúc 3 cấp:
    - mode = 'symlink': Tạo liên kết mềm trong thư mục '_Vault_3_Tier_Symlinks' (Không di chuyển file gốc, cực kỳ an toàn!)
    - mode = 'move': Di chuyển file vào 3 cấp, tự động lưu .vault_tiering_rollback.json để rollback.
    """
    vault_dir = Path(vault_dir).resolve()
    target_base = vault_dir if mode == 'move' else vault_dir / '_Vault_3_Tier_Symlinks'
    target_base.mkdir(parents=True, exist_ok=True)

    rollback_records = []
    success_count = 0
    error_count = 0
    errors = []

    for item in plan_items:
        src = vault_dir / item['original_path']
        if not src.exists():
            continue

        dst = target_base / item['dest_path']
        dst.parent.mkdir(parents=True, exist_ok=True)

        try:
            if mode == 'symlink':
                if dst.exists() or dst.is_symlink():
                    dst.unlink()
                # Sử dụng đường dẫn tương đối hoặc tuyệt đối cho symlink
                dst.symlink_to(src.resolve())
                success_count += 1
            elif mode == 'move':
                if dst.exists() and dst != src:
                    # Tránh ghi đè
                    stem = dst.stem
                    counter = 1
                    while dst.exists():
                        dst = dst.parent / f"{stem}_{counter}{dst.suffix}"
                        counter += 1
                shutil.move(src, dst)
                rollback_records.append({
                    'original': str(src),
                    'moved_to': str(dst)
                })
                success_count += 1
        except Exception as e:
            error_count += 1
            errors.append(f"{src.name}: {str(e)}")

    if mode == 'move' and rollback_records:
        rollback_file = vault_dir / '.vault_tiering_rollback.json'
        with open(rollback_file, 'w', encoding='utf-8') as f:
            json.dump(rollback_records, f, indent=2, ensure_ascii=False)

    return {
        'success': True,
        'mode': mode,
        'success_count': success_count,
        'error_count': error_count,
        'target_base': str(target_base),
        'message': f"Đã xuất thành công {success_count} tệp theo chuẩn 3 Cấp Vault ({'Symlink an toàn' if mode == 'symlink' else 'Di chuyển trực tiếp'})!"
    }

def rollback_vault_tiering(vault_dir: Path) -> Dict[str, Any]:
    """
    Khôi phục lại toàn bộ vị trí file nếu đã thực thi mode 'move'.
    """
    vault_dir = Path(vault_dir).resolve()
    rollback_file = vault_dir / '.vault_tiering_rollback.json'
    if not rollback_file.exists():
        return {'success': False, 'message': 'Không tìm thấy tệp rollback .vault_tiering_rollback.json'}

    try:
        with open(rollback_file, encoding='utf-8') as f:
            records = json.load(f)
    except Exception as e:
        return {'success': False, 'message': f'Lỗi đọc tệp rollback: {e}'}

    restored = 0
    errors = []
    for r in records:
        src = Path(r['moved_to'])
        dst = Path(r['original'])
        if src.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.move(src, dst)
                restored += 1
            except Exception as e:
                errors.append(f"{src} -> {dst}: {e}")

    # Xóa file rollback sau khi hoàn tất
    if restored > 0:
        try:
            rollback_file.unlink()
        except Exception:
            pass

    return {
        'success': True,
        'restored_count': restored,
        'errors': errors,
        'message': f"Đã khôi phục hoàn chỉnh {restored} tệp về vị trí thư mục nguyên bản!"
    }
