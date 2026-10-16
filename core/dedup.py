import os
import json
import hashlib
import sqlite3
import re
from pathlib import Path
from collections import defaultdict
import mutagen
from core.fingerprint import compare_audio_files

AUDIO_EXTENSIONS = {'.flac', '.wav', '.dsf', '.dff', '.m4a', '.mp3', '.ape', '.ogg', '.opus', '.wma'}
IGNORE_DIRS = {'_Vault_3_Tier_Symlinks', '.git', '.agents', '.gemini', 'brain', 'scratch', 'tools', 'cache', '_Duplicates_Archive'}

def get_cache_db(root_dir=None):
    cache_path = Path(__file__).resolve().parent.parent / 'cache' / 'scan_cache.sqlite'
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(cache_path)
    c = conn.cursor()
    c.execute("""
    CREATE TABLE IF NOT EXISTS file_cache (
        path TEXT PRIMARY KEY,
        mtime REAL,
        size INTEGER,
        header_hash TEXT,
        full_md5 TEXT,
        artist TEXT,
        title TEXT,
        album TEXT,
        duration REAL,
        ext TEXT,
        fingerprint TEXT
    )
    """)
    # Migration if table exists without fingerprint column
    c.execute("PRAGMA table_info(file_cache)")
    cols = [col[1] for col in c.fetchall()]
    if 'fingerprint' not in cols:
        try:
            c.execute("ALTER TABLE file_cache ADD COLUMN fingerprint TEXT")
        except Exception:
            pass
    conn.commit()
    return conn

def normalize_text(text):
    if not text:
        return ''
    return re.sub(r'[^\w\s]', '', str(text).lower()).strip()

def clean_title_for_clustering(title, artist, rel_path):
    t = str(title or '').strip()
    a = str(artist or '').strip()
    if not t and rel_path:
        t = Path(rel_path).stem
    if a:
        t = re.sub(r'\s*-\s*' + re.escape(a) + r'\b', '', t, flags=re.I)
        t = re.sub(r'^' + re.escape(a) + r'\s*-\s*', '', t, flags=re.I)
    # Strip track number prefixes like '01. ', '1-05 '
    t = re.sub(r'^\d+[\s\.\-_]+', '', t)
    t = re.sub(r'^\d+-\d+[\s\.\-_]+', '', t)
    # Strip (Remaster), (2017 Remaster), [2011 Remastered], etc.
    t = re.sub(r'[\(\[]\s*(?:\d{4}\s*)?remaster(?:ed)?\s*[\)\]]', '', t, flags=re.I)
    t = re.sub(r'[\(\[]\s*\d+\s*[\)\]]', '', t)
    t = re.sub(r'[\(\[](?:official\s*(?:mv|music\s*video|audio|video)|320\s*kbps|128\s*kbps)[\)\]]', '', t, flags=re.I)
    return normalize_text(t)

def score_file_for_keeping(rel_path, cache_row=None, specs=''):
    """
    Chấm điểm mức độ ưu tiên GIỮ LẠI của tệp (Điểm càng cao càng ưu tiên giữ lại).
    Bộ tiêu chuẩn chất âm Audiophile & Độ tin cậy tệp:
    1. Định dạng âm thanh: DSD (SACD) > Hi-Res Lossless 24-bit > CD Lossless 16-bit (WAV/FLAC) > High Lossy (AAC/M4A/320k) > Low Lossy.
    2. Thông số kỹ thuật: Ưu tiên Bit-depth (24bit > 16bit) và Sample rate (192k > 96k > 48k > 44.1k).
    3. Trừ điểm RẤT NẶNG tệp bản sao tải trùng: (1), (2), [1], _1, - Copy (-8000đ).
    4. Trừ điểm nặng tệp rip trôi nổi từ web kèm tên miền: NhacPro.net, ChiaSeNhac, NhacCuaTui, ZingMP3, Y2mate (-3000đ).
    5. Cấu trúc thư mục: Ưu tiên tệp nằm trong thư mục Album hoàn chỉnh có năm phát hành [1984], [2016] thay vì vứt bừa ngoài thư mục gốc.
    6. Độ trọn vẹn Metadata & tiếng Việt có dấu.
    """
    score = 1000.0
    p = Path(rel_path)
    fn = p.name
    fn_lower = fn.lower()
    ext = p.suffix.lower().lstrip('.')
    parts = p.parts

    specs_lower = (specs or '').lower()
    size_mb = 0.0

    if cache_row:
        # cache_row: [rel, mtime, size, header_hash, full_md5, artist, title, album, duration, ext]
        if len(cache_row) > 2 and cache_row[2]:
            size_mb = round(cache_row[2] / (1024 * 1024), 2)
        if len(cache_row) > 9 and cache_row[9]:
            ext = cache_row[9].lower().lstrip('.')

    # 1. Format Tier (Thứ hạng định dạng)
    if ext in ('dsf', 'dff'):
        score += 5000.0
    elif ext in ('flac', 'wav', 'aif', 'aiff', 'alac', 'ape'):
        if any(h in specs_lower for h in ('24bit', '32bit', '96k', '192k', '88.2k', '176.4k')):
            score += 4500.0
        else:
            score += 3500.0
    elif ext in ('m4a', 'aac', 'ogg', 'opus'):
        score += 1800.0
    elif ext == 'mp3':
        score += 1200.0
    else:
        score += 800.0

    # 2. Specs Precision (Độ phân giải & Tần số lấy mẫu)
    if '24bit' in specs_lower or '32bit' in specs_lower: score += 600.0
    if '192k' in specs_lower or '176.4k' in specs_lower: score += 500.0
    elif '96k' in specs_lower or '88.2k' in specs_lower: score += 400.0
    elif '48k' in specs_lower: score += 100.0

    if '320k' in specs_lower: score += 250.0
    elif '256k' in specs_lower: score += 150.0
    elif '128k' in specs_lower: score -= 300.0

    # Kích thước tệp (Bảo vệ tránh tệp bị cắt cụt / tải dở)
    score += min(size_mb * 2.0, 300.0)

    # 3. Trừ điểm rất nặng bản sao lưu tải trùng lặp
    if re.search(r'\(\s*\d+\s*\)', fn): score -= 8000.0
    if re.search(r'\[\s*\d+\s*\](?!\s*[\.\w])', fn): score -= 6000.0
    if re.search(r'[-_\s]copy\b', fn_lower): score -= 8000.0
    if re.search(r'_1\.[a-zA-Z0-9]+$', fn_lower): score -= 5000.0

    # 4. Trừ điểm tệp dán nhãn web rip / tag video rác
    if re.search(r'nhacpro\.net|chiasenhac|nhaccuatui|zingmp3|y2mate|tubidy', fn_lower):
        score -= 3000.0
    if re.search(r'\((official\s*(?:mv|music\s*video|audio|video)|lyric\s*video)\)', fn_lower):
        score -= 1500.0
    if re.search(r'\((128\s*kbps)\)', fn_lower):
        score -= 2500.0
    if re.search(r'\((320\s*kbps)\)', fn_lower):
        score -= 300.0
    if fn.startswith('#') or fn.startswith('.'):
        score -= 500.0
    if ' - -' in fn or '--' in fn:
        score -= 300.0

    # 5. Cấu trúc thư mục: Ưu tiên nằm trong album thay vì root
    depth = len(parts) - 1
    if depth >= 2:
        score += 500.0
        parent = parts[-2].lower()
        if re.search(r'\[\d{4}\]|\(\d{4}\)|\b(19\d\d|20\d\d)\b', parent):
            score += 300.0
        if any(kw in parent for kw in ('album', 'disc', 'cd', 'vinyl', 'remaster', 'soundtrack', 'ost')):
            score += 200.0
    elif depth == 1:
        score += 200.0
    else:
        score -= 400.0  # File vứt mồ côi ở root

    # Track number chuẩn ở đầu tên file (ví dụ "08. Your Eyes.flac")
    if re.match(r'^\d{2,3}[\.\s_-]', fn):
        score += 150.0

    # 6. Ưu tiên Metadata đầy đủ
    if cache_row:
        art = (cache_row[5] or '').strip().lower() if len(cache_row) > 5 else ''
        tit = (cache_row[6] or '').strip().lower() if len(cache_row) > 6 else ''
        alb = (cache_row[7] or '').strip().lower() if len(cache_row) > 7 else ''

        if tit and tit not in ('track', 'untitled', 'no title'): score += 150.0
        if art and art not in ('unknown', 'unknown artist', 'none'): score += 150.0
        if alb and alb not in ('unknown', 'unknown album', 'none', 'singles'): score += 150.0

    # Ký tự tiếng Việt có dấu
    vn_chars = r'[àáảãạâầấẩẫậăằắẳẵặèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđĐ]'
    if re.search(vn_chars, fn, flags=re.I):
        score += 200.0

    # Tie-breaker: mtime cũ hơn (tệp tải về trước là bản gốc)
    if cache_row and len(cache_row) > 1 and cache_row[1]:
        score -= (float(cache_row[1]) / 1e11)

    return score

def scan_duplicates(root_dir, force_refresh=False):
    root = Path(root_dir).resolve()
    conn = get_cache_db(root)
    c = conn.cursor()

    # Load existing cache
    c.execute("SELECT path, mtime, size, header_hash, full_md5, artist, title, album, duration, ext FROM file_cache")
    cache = {row[0]: list(row) for row in c.fetchall()}

    # 1. Ultra-fast directory walk with os.scandir
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS and not d.startswith('.')]
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            if ext in AUDIO_EXTENSIONS:
                p = os.path.join(dirpath, fn)
                try:
                    if not Path(p).resolve().is_relative_to(root):
                        continue
                    st = os.stat(p)
                    rel = os.path.relpath(p, root)
                    files.append((rel, p, st.st_size, st.st_mtime, ext))
                except Exception:
                    pass

    # 2. Incremental Cache Update (only new or modified files)
    to_insert = []
    active_cache = {}
    current_paths = set()

    for rel, full_p, sz, mt, ext in files:
        current_paths.add(rel)
        row = cache.get(rel)
        if not force_refresh and row and row[1] == mt and row[2] == sz:
            active_cache[rel] = row
        else:
            art, tit, alb, dur = "", "", "", 0.0
            try:
                m = mutagen.File(full_p, easy=True)
                if m:
                    tit = (m.get('title', [''])[0] or '').strip()
                    art = (m.get('artist', [''])[0] or m.get('albumartist', [''])[0] or '').strip()
                    alb = (m.get('album', [''])[0] or '').strip()
                    dur = round(getattr(m.info, 'length', 0.0), 1)
            except Exception:
                pass
            new_row = [rel, mt, sz, None, None, art, tit, alb, dur, ext]
            active_cache[rel] = new_row
            to_insert.append(tuple(new_row))

    if to_insert:
        c.executemany("INSERT OR REPLACE INTO file_cache (path, mtime, size, header_hash, full_md5, artist, title, album, duration, ext) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", to_insert)
        conn.commit()

    # Clean up deleted files from cache
    deleted_paths = set(cache.keys()) - current_paths
    if deleted_paths:
        c.executemany("DELETE FROM file_cache WHERE path = ?", [(p,) for p in deleted_paths])
        conn.commit()

    # 3. Level 1: Byte Identical (Filter by Size -> 4KB Header -> Full MD5)
    by_size = defaultdict(list)
    for rel, row in active_cache.items():
        if row[2] > 0:
            by_size[row[2]].append(rel)

    to_update_hashes = []
    byte_duplicates = []

    for sz, flist in by_size.items():
        if len(flist) > 1:
            # Check 4KB header hash
            by_header = defaultdict(list)
            for rel in flist:
                row = active_cache[rel]
                h_hash = row[3]
                full_p = root / rel
                if not h_hash and full_p.exists():
                    try:
                        with open(full_p, 'rb') as f:
                            h_hash = hashlib.md5(f.read(4096)).hexdigest()
                        row[3] = h_hash
                        to_update_hashes.append((row[3], row[4], rel))
                    except Exception:
                        pass
                if h_hash:
                    by_header[h_hash].append(rel)

            # Check full MD5 for header matches
            for h_hash, sublist in by_header.items():
                if len(sublist) > 1:
                    by_full = defaultdict(list)
                    for rel in sublist:
                        row = active_cache[rel]
                        f_md5 = row[4]
                        full_p = root / rel
                        if not f_md5 and full_p.exists():
                            try:
                                h = hashlib.md5()
                                with open(full_p, 'rb') as f:
                                    while chunk := f.read(65536):
                                        h.update(chunk)
                                f_md5 = h.hexdigest()
                                row[4] = f_md5
                                to_update_hashes.append((row[3], row[4], rel))
                            except Exception:
                                pass
                        if f_md5:
                            by_full[f_md5].append(rel)

                    for md5, dupes in by_full.items():
                        if len(dupes) > 1:
                            # Sắp xếp theo điểm ưu tiên giữ lại (điểm cao nhất ở vị trí 0)
                            dupes_sorted = sorted(
                                dupes,
                                key=lambda f: score_file_for_keeping(f, active_cache.get(f)),
                                reverse=True
                            )
                            byte_duplicates.append({
                                'hash': md5,
                                'size_bytes': sz,
                                'size_mb': round(sz / (1024 * 1024), 2),
                                'files': dupes_sorted
                            })

    if to_update_hashes:
        c.executemany("UPDATE file_cache SET header_hash = ?, full_md5 = ? WHERE path = ?", to_update_hashes)
        conn.commit()

    conn.close()

    # Nạp organize_plan.json nếu có để làm giàu thông tin specs (bit-depth/sample-rate/bitrate)
    specs_map = {}
    plan_file = root / 'organize_plan.json'
    if not plan_file.exists():
        plan_file = Path(__file__).resolve().parent.parent / 'organize_plan.json'
    if plan_file.exists():
        try:
            with open(plan_file, 'r', encoding='utf-8') as pf:
                plan_items = json.load(pf)
                for it in plan_items:
                    orig_p = it.get('original_path')
                    if orig_p and 'specs' in it:
                        specs_map[orig_p] = it['specs']
        except Exception:
            pass

    # 4. Level 2: Filename Identical in Different Folders
    by_name = defaultdict(list)
    for rel, row in active_cache.items():
        fn = Path(rel).name.lower()
        by_name[fn].append((rel, row[2]))

    name_duplicates = []
    for fn, flist in by_name.items():
        if len(flist) > 1:
            flist_sorted = sorted(flist, key=lambda x: score_file_for_keeping(x[0], active_cache.get(x[0])), reverse=True)
            name_id = f"name_{hashlib.md5(fn.encode('utf-8')).hexdigest()[:12]}"
            files_items = []
            for rel, sz in flist_sorted:
                fn_part = Path(rel).name
                has_num = bool(re.search(r'\(\s*\d+\s*\)', fn_part) or re.search(r'[-_\s]copy\b', fn_part, flags=re.I))
                ext_part = Path(rel).suffix.lower()
                is_lossless = ext_part in ('.flac', '.wav', '.dsf', '.dff', '.ape')
                files_items.append({
                    'path': rel,
                    'filename': fn_part,
                    'size_mb': round(sz / (1024 * 1024), 2),
                    'ext': ext_part,
                    'specs': specs_map.get(rel, ''),
                    'is_lossless': is_lossless,
                    'has_number_suffix': has_num
                })
            name_duplicates.append({
                'id': name_id,
                'filename': Path(flist_sorted[0][0]).name,
                'files': files_items,
                'recommended_keep': files_items[0],
                'duplicates': files_items[1:]
            })

    # 5. Level 3: Metadata Identical (Artist + Title normalized & duration check)
    by_meta = defaultdict(list)
    for rel, row in active_cache.items():
        _, _, sz, _, _, art, tit, alb, dur, ext = row
        c_tit = clean_title_for_clustering(tit, art, rel)
        
        if c_tit and len(c_tit) >= 3 and dur > 20:
            item = {
                'path': rel,
                'artist': art or 'Unknown Artist',
                'title': tit or Path(rel).stem,
                'album': alb,
                'duration': dur,
                'ext': ext,
                'clean_title': c_tit,
                'size_mb': round(sz / (1024 * 1024), 2)
            }
            # Cluster by cleaned title
            by_meta[c_tit].append(item)

    meta_duplicates = []
    for c_tit, flist in by_meta.items():
        if len(flist) > 1:
            # Cluster by duration and artist similarity
            subclusters = []
            for item in flist:
                matched = False
                for cluster in subclusters:
                    dur_diff = abs(cluster[0]['duration'] - item['duration'])
                    c_art = normalize_text(cluster[0].get('artist', ''))
                    i_art = normalize_text(item.get('artist', ''))
                    same_art = (c_art == i_art) and (c_art != '')
                    
                    # Match if:
                    # 1. Same artist and duration diff <= 15s (remasters, intro/outro silence diff)
                    # 2. Duration diff <= 6.0s (even if artist naming differs e.g. English vs Kanji, or missing)
                    # 3. Either duration is 0 (mutagen couldn't parse length)
                    if (same_art and dur_diff <= 15.0) or (dur_diff <= 6.0) or (item['duration'] == 0 or cluster[0]['duration'] == 0):
                        cluster.append(item)
                        matched = True
                        break
                if not matched:
                    subclusters.append([item])

            for cluster in subclusters:
                if len(cluster) > 1:
                    cluster_sorted = sorted(
                        cluster,
                        key=lambda it: score_file_for_keeping(it['path'], active_cache.get(it['path']), specs_map.get(it['path'], '')),
                        reverse=True
                    )
                    cluster_id = f"meta_{hashlib.md5((cluster_sorted[0]['artist'] + '_' + cluster_sorted[0]['title'] + '_' + str(len(cluster_sorted))).encode('utf-8')).hexdigest()[:12]}"
                    
                    enriched_files = []
                    has_lossless = False
                    has_lossy = False
                    ref_p = str(root / cluster_sorted[0]['path'])
                    for f_idx, f_item in enumerate(cluster_sorted):
                        ext_lower = f_item.get('ext', '').lower()
                        is_lossless = ext_lower in ('.flac', '.wav', '.dsf', '.dff', '.ape')
                        if is_lossless:
                            has_lossless = True
                        else:
                            has_lossy = True
                        fn_name = Path(f_item['path']).name
                        has_num = bool(re.search(r'\(\s*\d+\s*\)', fn_name) or re.search(r'[-_\s]copy\b', fn_name, flags=re.I))

                        # So sánh âm học Chromaprint với bản đề xuất giữ
                        acoustic_pct = 100.0
                        if f_idx > 0:
                            try:
                                cand_p = str(root / f_item['path'])
                                acoustic_pct = compare_audio_files(ref_p, cand_p)
                            except Exception:
                                acoustic_pct = None

                        enriched_files.append({
                            **f_item,
                            'filename': fn_name,
                            'specs': specs_map.get(f_item['path'], ''),
                            'is_lossless': is_lossless,
                            'has_number_suffix': has_num,
                            'acoustic_match_pct': acoustic_pct
                        })

                    distinct_exts = set(f['ext'].lower() for f in enriched_files)
                    meta_duplicates.append({
                        'id': cluster_id,
                        'artist': cluster_sorted[0]['artist'],
                        'title': cluster_sorted[0]['title'],
                        'has_flac_vs_lossy': (has_lossless and has_lossy),
                        'has_mixed_formats': len(distinct_exts) > 1,
                        'has_numbered_file': any(f['has_number_suffix'] for f in enriched_files),
                        'files': enriched_files,
                        'recommended_keep': enriched_files[0],
                        'duplicates': enriched_files[1:]
                    })

    return {
        'total_scanned': len(active_cache),
        'byte_duplicates_count': len(byte_duplicates),
        'name_duplicates_count': len(name_duplicates),
        'meta_duplicates_count': len(meta_duplicates),
        'byte_duplicates': byte_duplicates,
        'name_duplicates': name_duplicates,
        'meta_duplicates': meta_duplicates
    }

def get_metadata_duplicates_map(root_dir):
    """
    Trả về dictionary tra cứu nhanh cho từng bài hát:
    filepath -> { 'is_duplicate': True, 'dupe_count': int, 'dupe_status': 'keep'|'archive', 'group_id': ..., 'group_title': ... }
    """
    res = scan_duplicates(root_dir)
    meta_dupes = res.get('meta_duplicates', [])
    dupe_map = {}
    for g in meta_dupes:
        rec_keep = g.get('recommended_keep', {}).get('path') if isinstance(g.get('recommended_keep'), dict) else (g['files'][0]['path'] if isinstance(g['files'][0], dict) else g['files'][0])
        for f in g['files']:
            fp = f['path'] if isinstance(f, dict) else f
            dupe_map[fp] = {
                'is_duplicate': True,
                'group_id': g['id'],
                'group_title': f"{g.get('artist', 'Unknown')} - {g.get('title', '')}",
                'dupe_count': len(g['files']),
                'dupe_status': 'keep' if fp == rec_keep else 'archive',
                'recommended_keep': rec_keep,
                'all_group_files': [x['path'] if isinstance(x, dict) else x for x in g['files']]
            }
    return dupe_map, len(meta_dupes)
