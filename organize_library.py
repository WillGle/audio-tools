#!/usr/bin/env python3
"""
Công cụ phân loại và chuẩn hóa kho nhạc theo Metadata.
Tách 3 cấp:
  01_Hi-Res & DSD
  02_Lossless_CD
  03_Lossy_MP3_AAC
Và cấu trúc: <Tier>/<Artist>/[<Year> - ]<Album>/<Track> - <Title>.<ext>

Hỗ trợ:
  --dry-run (mặc định): Mô phỏng, xuất bảng kế hoạch, không di chuyển file
  --execute: Thực thi di chuyển và lưu log rollback để có thể khôi phục
  --rollback: Khôi phục vị trí file từ nhật ký di chuyển
"""

import sys
import os
import re
import json
import shutil
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

AUDIO_EXTENSIONS = {'.flac', '.wav', '.dsf', '.dff', '.m4a', '.mp3', '.ape', '.aac', '.ogg', '.opus', '.wma', '.aif', '.aiff'}

def clean_str(s):
    if not s:
        return ''
    s = re.sub(r'[/\\:*?"<>|]', '_', str(s))
    s = re.sub(r'\s+', ' ', s)
    return s.strip()

def strip_junk(name):
    name = re.sub(r'\[(128kbps_MP3|Lossless_FLAC|FLAC|320\s*kbps|MP3|24bit-96KHz|UHQCD|CD-AccurateRip-[^\]]+|SACD)\]', '', name, flags=re.I)
    name = re.sub(r'\((320\s*kbps|128\s*kbps|Official Music Video|Official Audio|Official MV|MusicVideo|NhacPro\.net|online-audio-converter\.com)\)', '', name, flags=re.I)
    name = re.sub(r'[\(\[][^\)\]]*\.(com|vn|net|org)[^\)\]]*[\)\]]', '', name, flags=re.I)
    name = re.sub(r'\s*-\s*\d{6,}', '', name)
    name = re.sub(r'_+', ' ', name)
    name = re.sub(r'\s+', ' ', name)
    return name.strip(' _-')

def is_junk_album(album):
    if not album:
        return True
    a = album.strip().lower()
    junk_patterns = [
        'nhaccuatui', 'zing', 'nhacpro', 'chiasenhac', 'cscn',
        '.com', '.vn', '.net', '.org', 'no title', 'none', 'unknown',
        'untitled', 'tải về', 'lossless', 'mp3'
    ]
    if any(p in a for p in junk_patterns):
        return True
    if a in {'single', '[single]', 'album', '[album]', 'audio'}:
        return True
    return False

def parse_track_number(trk_str):
    if not trk_str:
        return ''
    trk_str = str(trk_str).split('/')[0].split('_')[0].strip()
    try:
        val = int(trk_str)
        return f"{val:02d}"
    except:
        return ''

def process_file_metadata(filepath, pre_scanned_specs, hires_verdicts):
    import mutagen
    p = Path(filepath)
    ext = p.suffix.lower()
    
    title = ''
    artist = ''
    album = ''
    track = ''
    year = ''
    
    sr = 44100
    bits = 16
    codec = ext[1:]
    
    p_str = str(filepath)
    if p_str in pre_scanned_specs:
        spec = pre_scanned_specs[p_str]
        codec = spec.get('codec', codec)
        sr = spec.get('sample_rate', 44100)
        bits = spec.get('bit_depth', 16)
        
    try:
        m = mutagen.File(p, easy=True)
        if m:
            title = clean_str(m.get('title', [''])[0])
            artist = clean_str(m.get('artist', [''])[0] or m.get('albumartist', [''])[0])
            album = clean_str(m.get('album', [''])[0])
            track = parse_track_number(clean_str(m.get('tracknumber', [''])[0]))
            date_val = clean_str(m.get('date', [''])[0])
            if date_val and len(date_val) >= 4 and date_val[:4].isdigit():
                year = date_val[:4]
                
            if p_str not in pre_scanned_specs and hasattr(m, 'info'):
                sr = getattr(m.info, 'sample_rate', sr)
                bits = getattr(m.info, 'bits_per_sample', bits)
                codec = getattr(m.info, 'codec', codec)
    except Exception:
        pass
        
    name_stem = p.stem
    is_numeric_stem = name_stem.isdigit() and len(name_stem) > 8
    
    if not title:
        if not is_numeric_stem:
            cleaned_stem = strip_junk(name_stem)
            if ' - ' in cleaned_stem:
                parts = cleaned_stem.split(' - ', 1)
                if not artist:
                    artist = clean_str(parts[0])
                title = clean_str(parts[1])
            else:
                title = clean_str(cleaned_stem)
        else:
            if artist:
                title = f"Track_{name_stem}"
            else:
                title = ""
                
    if not artist and ' - ' in name_stem and not is_numeric_stem:
        artist = clean_str(name_stem.split(' - ', 1)[0])

    if is_junk_album(album):
        album = ''

    verdict_info = hires_verdicts.get(p_str, {})
    v = verdict_info.get('verdict', '')
    
    if v == 'FAKE_HIRES_UPSAMPLED':
        tier = '01_Hi-Res & DSD/Upsampled_Fake_HiRes'
    elif v == 'FAKE_LOSSLESS':
        tier = '02_Lossless_CD/Fake_Lossless_Transcodes'
    elif 'dsd' in codec or ext in ('.dsf', '.dff'):
        tier = '01_Hi-Res & DSD'
    elif bits > 16 or sr > 48000:
        tier = '01_Hi-Res & DSD'
    elif ext in ('.flac', '.wav', '.ape', '.aif', '.aiff') or codec.lower() in ('alac', 'wmalossless'):
        tier = '02_Lossless_CD'
    else:
        tier = '03_Lossy_MP3_AAC'

    return {
        'title': title,
        'artist': artist,
        'album': album,
        'track': track,
        'year': year,
        'codec': codec,
        'sr': sr,
        'bits': bits,
        'tier': tier
    }

def build_destination_path(root_dir, tier, meta, orig_path):
    p = Path(orig_path)
    ext = p.suffix.lower()
    
    artist = meta['artist'] or 'Unknown Artist'
    album = meta['album']
    title = meta['title']
    track = meta['track']
    year = meta['year']
    
    artist = clean_str(artist)
    if not artist or artist.lower() in ('unknown', 'none', 'various'):
        artist = 'Unknown Artist'
        
    if album:
        album_folder = f"[{year}] {album}" if year else album
        album_folder = clean_str(album_folder)
        dest_dir = Path(root_dir) / tier / artist / album_folder
        if track and title:
            new_filename = f"{track}. {title}{ext}"
        elif title:
            new_filename = f"{title}{ext}"
        else:
            new_filename = f"{strip_junk(p.stem)}{ext}"
    else:
        if artist == 'Unknown Artist' and not title:
            dest_dir = Path(root_dir) / tier / "Unknown Artist" / "Unidentified_Tracks"
            new_filename = f"Track_{p.stem}{ext}"
        else:
            dest_dir = Path(root_dir) / tier / artist / "Singles"
            if title:
                if artist != 'Unknown Artist':
                    if title.lower().startswith(artist.lower() + ' - '):
                        new_filename = f"{title}{ext}"
                    elif title.lower().endswith(' - ' + artist.lower()):
                        clean_t = title[:-len(artist)-3].strip(' -_')
                        new_filename = f"{artist} - {clean_t}{ext}"
                    else:
                        new_filename = f"{artist} - {title}{ext}"
                else:
                    new_filename = f"{title}{ext}"
            else:
                new_filename = f"{strip_junk(p.stem)}{ext}"
            
    new_filename = clean_str(new_filename)
    if not new_filename or new_filename == ext:
        new_filename = f"Track_{p.stem}{ext}"
        
    return dest_dir / new_filename

def main():
    mode = '--dry-run'
    target_dir = None
    
    for arg in sys.argv[1:]:
        if arg in ('--execute', '-e'):
            mode = '--execute'
        elif arg == '--rollback':
            mode = '--rollback'
        elif arg in ('--dry-run', '-d'):
            mode = '--dry-run'
        elif not arg.startswith('-'):
            target_dir = Path(arg).resolve()

    # Xác định thư mục kho nhạc
    script_dir = Path(__file__).resolve().parent
    if target_dir:
        root = target_dir
    elif script_dir.name in ('tools', 'scripts', 'app'):
        root = script_dir.parent
    else:
        root = Path.cwd().resolve()
        
    if mode == '--rollback':
        from core.vault_tiering import rollback_vault_tiering
        result = rollback_vault_tiering(root)
        print(result['message'])
        return 0 if result['success'] else 1

    print(f"========================================================================")
    print(f"   CHƯƠNG TRÌNH PHÂN LOẠI & CHUẨN HÓA KHO NHẠC THEO METADATA")
    print(f"   Thư mục làm việc: {root}")
    print(f"   Chế độ: {'⚡ THỰC THI CHUYỂN FILE' if mode == '--execute' else '🔍 MÔ PHỎNG (DRY-RUN)'}")
    print(f"========================================================================")

    # Đọc cache specs
    pre_scanned_specs = {}
    spec_cache = script_dir / 'cache' / 'metadata_results.json'
    if spec_cache.exists():
        with open(spec_cache, encoding='utf-8') as f:
            for item in json.load(f):
                pre_scanned_specs[item.get('path', '')] = item

    # Đọc kết quả kiểm định Hi-Res
    hires_verdicts = {}
    verdict_file = script_dir / 'cache' / 'hires_verdicts.json'
    if verdict_file.exists():
        with open(verdict_file, encoding='utf-8') as f:
            for item in json.load(f):
                hires_verdicts[item.get('filepath', '')] = item

    ignore_dirs = {
        '.git', '.agents', '.gemini', 'brain', 'scratch',
        'tools', 'scripts', 'app', 'bin', 'cache', '_Duplicates_Archive', '_Vault_3_Tier_Symlinks',
        '01_Hi-Res & DSD', '02_Lossless_CD', '03_Lossy_MP3_AAC'
    }
    all_audio = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ignore_dirs]
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            if ext in AUDIO_EXTENSIONS:
                candidate = Path(dirpath) / fn
                if candidate.resolve().is_relative_to(root):
                    all_audio.append(candidate)

    print(f"Tìm thấy {len(all_audio)} file âm thanh cần phân loại.")
    
    def process_item(p):
        rel_orig = p.relative_to(root)
        meta = process_file_metadata(str(p), pre_scanned_specs, hires_verdicts)
        tier = meta['tier']
        dest_path = build_destination_path(root, tier, meta, p)
        rel_dest = dest_path.relative_to(root)
        is_num = p.stem.isdigit() and len(p.stem) > 8
        is_recovered = is_num and meta['title'] and not meta['title'].startswith('Track_')
        return {
            'original_path': str(rel_orig),
            'target_path': str(rel_dest),
            'tier': tier,
            'artist': meta['artist'] or 'Unknown Artist',
            'album': meta['album'] or 'Singles',
            'title': meta['title'] or p.stem,
            'specs': f"{meta['codec'].upper()} {meta['bits']}bit/{meta['sr']/1000:.1f}kHz",
            'was_numeric': is_num,
            'is_recovered': is_recovered
        }

    print("Đang trích xuất metadata và tính toán đường dẫn mới (đa luồng)...")
    with ThreadPoolExecutor(max_workers=16) as ex:
        plan = list(ex.map(process_item, all_audio))

    tier_counts = {}
    numeric_recovered = 0
    for item in plan:
        tb = item['tier'].split('/')[0]
        tier_counts[tb] = tier_counts.get(tb, 0) + 1
        if item.get('is_recovered'):
            numeric_recovered += 1

    # Lưu kế hoạch vào thư mục tools
    tools_dir = script_dir
    tools_dir.mkdir(parents=True, exist_ok=True)
    plan_out = tools_dir / 'organize_plan.json'
    with open(plan_out, 'w', encoding='utf-8') as f:
        json.dump(plan, f, ensure_ascii=False, indent=2)

    print(f"\n=== TỔNG KẾT PHÂN LOẠI ===")
    for t, c in sorted(tier_counts.items()):
        print(f"  📁 {t}: {c} tracks")
    print(f"  ✨ Số file số vô danh được giải mã tên thành công: {numeric_recovered}")
    print(f"  📝 Đã lưu kế hoạch chi tiết tại: {plan_out}")

    preview_md = tools_dir / 'organize_preview.md'
    with open(preview_md, 'w', encoding='utf-8') as f:
        f.write("# BẢNG XEM TRƯỚC KẾ HOẠCH PHÂN LOẠI & ĐỔI TÊN KHO NHẠC\n\n")
        f.write(f"- **Tổng số tệp âm thanh**: {len(all_audio)}\n")
        f.write(f"- **File số vô danh được phục hồi tên bài & ca sĩ**: {numeric_recovered} file\n")
        f.write("\n## 1. Phân Bổ Theo 3 Nhóm Chất Lượng\n\n")
        for t, c in sorted(tier_counts.items()):
            f.write(f"- **{t}**: `{c}` bài hát\n")
            
        f.write("\n## 2. Các Bài Hát Số Vô Danh Được Phục Hồi Tên (Mẫu 25 bài)\n\n")
        f.write("| Tên File Cũ (Số) | Định Dạng | Tên Bài Hát & Ca Sĩ Phục Hồi | Vị Trí Mới Đề Xuất |\n")
        f.write("| :--- | :--- | :--- | :--- |\n")
        num_samples = [x for x in plan if x.get('is_recovered')][:25]
        for s in num_samples:
            f.write(f"| `{Path(s['original_path']).name}` | {s['specs']} | **{s['artist']}** - {s['title']} | `{s['target_path']}` |\n")

        f.write("\n## 3. Các Album Hi-Res & Lossless Được Gom Nhóm Lại (Mẫu 25 bài)\n\n")
        f.write("| File Cũ | Vị Trí Mới Đề Xuất |\n")
        f.write("| :--- | :--- |\n")
        for s in plan[:25]:
            f.write(f"| `{s['original_path']}` | `{s['target_path']}` |\n")

    print(f"  📄 Đã cập nhật tài liệu xem trước tại: {preview_md}")

    if mode == '--execute':
        from core.vault_tiering import execute_tiering
        result = execute_tiering(root, [
            {'original_path': item['original_path'], 'dest_path': item['target_path']}
            for item in plan if item['original_path'] != item['target_path']
        ], mode='move')
        print(result['message'])
        for error in result['errors']:
            print(error, file=sys.stderr)
        return 0 if result['success'] else 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
