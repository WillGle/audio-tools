import os
import json
import hashlib
import sqlite3
import re
from pathlib import Path
from collections import defaultdict
import mutagen
from core.fingerprint import compare_audio_files
from core.paths import cache_directory

AUDIO_EXTENSIONS = {'.flac', '.wav', '.dsf', '.dff', '.m4a', '.mp3', '.ape', '.ogg', '.opus', '.wma'}
IGNORE_DIRS = {'_Vault_3_Tier_Symlinks', '.git', '.agents', '.gemini', 'brain', 'scratch', 'tools', 'cache', '_Duplicates_Archive'}

def get_cache_db(root_dir=None):
    vault_id = hashlib.sha256(str(Path(root_dir).resolve()).encode()).hexdigest()[:16] if root_dir else 'default'
    cache_path = cache_directory() / f'scan_cache-{vault_id}.sqlite'
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

def score_file_for_keeping(rel_path, cache_row=None, specs='', integrity=None):
    """Preference only: verified integrity outranks metadata and naming."""
    status = (integrity or {}).get('rules', {}).get('integrity', {}).get('status')
    rank = 0 if status == 'FAIL' or (integrity or {}).get('critical_failure') else 2 if status == 'PASS' else 1
    # Resolution/DSD and filename suffixes cannot establish sound quality.
    metadata = sum(bool(cache_row[i]) for i in (5, 6, 7)) if cache_row else 0
    filename = Path(rel_path).name
    duplicate_suffix = bool(re.search(r'\(\s*\d+\s*\)|[-_\s]copy\b|_1\.[^.]+$', filename, re.I))
    return rank * 10000 + metadata * 100 + min(len(Path(rel_path).parts) - 1, 5) * 10 - int(duplicate_suffix)


def current_integrity_results(root):
    from contextlib import closing
    from core.audio_scoring import engine_signature, load_config
    db = cache_directory() / 'audio_scoring.sqlite'
    if not db.exists():
        return {}
    results = {}
    try:
        with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)) as conn:
            rows = conn.execute('SELECT filepath,result FROM analysis_files').fetchall()
        for name, payload in rows:
            result = json.loads(payload)
            try:
                path = (root / name).resolve()
                if not path.is_relative_to(root):
                    continue
                st = path.stat()
                if (result.get('file_stat') == {'size_bytes': st.st_size, 'mtime_ns': st.st_mtime_ns, 'ctime_ns': st.st_ctime_ns}
                        and result.get('engine_signature') == engine_signature()
                        and result.get('rule_version') == load_config()['version'] and not result.get('preliminary')):
                    results[name] = result
            except OSError:
                continue
    except (sqlite3.Error, ValueError):
        return {}
    return results


def recommendation_reason(result):
    status = (result or {}).get('rules', {}).get('integrity', {}).get('status')
    if status == 'FAIL' or (result or {}).get('critical_failure'):
        return 'Có lỗi toàn vẹn; không ưu tiên giữ khi còn bản khác.'
    if status == 'PASS':
        return 'Đã đạt kiểm tra toàn vẹn; metadata và vị trí chỉ là ưu tiên phụ.'
    return 'Chưa có kiểm tra toàn vẹn còn hiệu lực; chỉ ưu tiên metadata và vị trí. Không xác minh chất lượng nghe hoặc bản master.'


def scan_duplicates(root_dir, force_refresh=False):
    root = Path(root_dir).resolve()
    integrity_results = current_integrity_results(root)
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
                    if Path(p).is_symlink() or not Path(p).resolve().is_relative_to(root):
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
                                key=lambda f: score_file_for_keeping(f, active_cache.get(f), integrity=integrity_results.get(f)),
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
            flist_sorted = sorted(flist, key=lambda x: score_file_for_keeping(x[0], active_cache.get(x[0]), integrity=integrity_results.get(x[0])), reverse=True)
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
                    'has_number_suffix': has_num,
                    'recommendation_reason': recommendation_reason(integrity_results.get(rel))
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
                        key=lambda it: score_file_for_keeping(it['path'], active_cache.get(it['path']), integrity=integrity_results.get(it['path'])),
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
                            'recommendation_reason': recommendation_reason(integrity_results.get(f_item['path'])),
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

    from core.duplicate_review import apply_decisions
    apply_decisions(root, {'byte_duplicates': byte_duplicates, 'name_duplicates': name_duplicates, 'meta_duplicates': meta_duplicates})

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
        if g.get('review_decision'):
            continue
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
    return dupe_map, sum(not g.get('review_decision') for g in meta_dupes)
