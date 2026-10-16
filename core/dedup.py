import os
import hashlib
import sqlite3
import re
from pathlib import Path
from collections import defaultdict
import mutagen

AUDIO_EXTENSIONS = {'.flac', '.wav', '.dsf', '.dff', '.m4a', '.mp3', '.ape', '.ogg', '.opus', '.wma'}
IGNORE_DIRS = {'.git', '.agents', '.gemini', 'brain', 'scratch', 'tools', 'cache', '_Duplicates_Archive'}

def get_cache_db(root_dir):
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
        ext TEXT
    )
    """)
    conn.commit()
    return conn

def normalize_text(text):
    if not text:
        return ''
    return re.sub(r'[^\w\s]', '', str(text).lower()).strip()

def score_file_for_keeping(rel_path, cache_row=None):
    """
    Chấm điểm mức độ ưu tiên GIỮ LẠI của tệp (Điểm càng cao càng ưu tiên giữ lại).
    Các tiêu chuẩn:
    1. Trừ điểm RẤT NẶNG nếu tên tệp có chứa (số) như (1), (2), [1], _1, - Copy.
       -> Mặc định các bản này là bản trùng, bị xếp xuống dưới để chuyển vào Archive.
    2. Ưu tiên tệp có Metadata đầy đủ hơn (Title, Artist, Album).
    3. Ưu tiên tệp nằm trong thư mục Album hoàn chỉnh (độ sâu >= 2) thay vì vứt bừa ngoài thư mục gốc.
    4. Ưu tiên tên tệp tiếng Việt chuẩn có dấu, trừ điểm file lỗi font / gãy ký tự / tiền tố # rác.
    5. Ưu tiên nhẹ file có ngày sửa đổi cũ hơn (bản gốc tải về trước).
    """
    score = 1000.0
    p = Path(rel_path)
    fn = p.name
    fn_lower = fn.lower()
    parts = p.parts

    # 1. Trừ điểm rất nặng file có (số) trong tên hoặc copy
    if re.search(r'\(\s*\d+\s*\)', fn):
        score -= 5000.0
    if re.search(r'\[\s*\d+\s*\](?!\s*[\.\w])', fn):
        score -= 3000.0
    if re.search(r'[-_\s]copy\b', fn_lower):
        score -= 5000.0
    if re.search(r'_1\.[a-zA-Z0-9]+$', fn_lower):
        score -= 2000.0

    # 2. Cấu trúc thư mục: Ưu tiên nằm trong album thay vì root
    depth = len(parts) - 1
    if depth >= 2:
        score += 400.0
    elif depth == 1:
        score += 200.0
    else:
        score -= 300.0  # File vứt mồ côi ở root

    # Folder cha có chứa năm phát hành [1982] hoặc từ khóa album
    if depth >= 1:
        parent = parts[-2]
        if re.search(r'\[\d{4}(?:\.\d{2}\.\d{2})?\]|\(\d{4}\)|\b(19\d\d|20\d\d)\b', parent):
            score += 200.0
        if any(kw in parent.lower() for kw in ('lossless', 'flac', 'album', 'disc', 'cd', 'vinyl', 'remaster')):
            score += 100.0

    # 3. Ưu tiên Metadata đầy đủ hơn
    if cache_row:
        # cache_row: [rel, mtime, size, header_hash, full_md5, artist, title, album, duration, ext]
        art = (cache_row[5] or '').strip() if len(cache_row) > 5 else ''
        tit = (cache_row[6] or '').strip() if len(cache_row) > 6 else ''
        alb = (cache_row[7] or '').strip() if len(cache_row) > 7 else ''

        if tit:
            score += 150.0
        if art and art.lower() not in ('unknown', 'unknown artist', 'none', 'various', 'various artists'):
            score += 150.0
        if alb and alb.lower() not in ('unknown', 'unknown album', 'none', 'untitled', 'no title'):
            score += 150.0

    # 4. Ký tự tiếng Việt có dấu vs lỗi font / gãy font
    vn_chars = r'[àáảãạâầấẩẫậăằắẳẵặèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđĐ]'
    if re.search(vn_chars, fn, flags=re.I):
        score += 250.0
    
    if ' - -' in fn or '--' in fn:
        score -= 200.0
    if fn.startswith('#') or fn.startswith('.'):
        score -= 150.0
    if '( lm g)' in fn or ' qun - Ngt' in fn or 'KHNG SAO U' in fn:
        score -= 400.0

    # Track number chuẩn ở đầu tên file (ví dụ "08. Your Eyes.flac")
    if re.match(r'^\d{2,3}[\.\s_-]', fn):
        score += 80.0

    # Phạt nhẹ nếu tên file kèm tag 320 kbps, Official MV rác
    if re.search(r'\((320\s*kbps|128\s*kbps|Official MV|Official Music Video)\)', fn, flags=re.I):
        score -= 50.0

    # 5. Tie-breaker: mtime cũ hơn (tệp tải về trước là bản gốc)
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
        c.executemany("INSERT OR REPLACE INTO file_cache VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", to_insert)
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

    # 4. Level 2: Filename Identical in Different Folders
    by_name = defaultdict(list)
    for rel, row in active_cache.items():
        fn = Path(rel).name.lower()
        by_name[fn].append((rel, row[2]))

    name_duplicates = []
    for fn, flist in by_name.items():
        if len(flist) > 1:
            name_duplicates.append({
                'filename': Path(flist[0][0]).name,
                'files': [
                    {
                        'path': rel,
                        'size_mb': round(sz / (1024 * 1024), 2)
                    }
                    for rel, sz in flist
                ]
            })

    # 5. Level 3: Metadata Identical (Artist + Title normalized & duration check)
    by_meta = defaultdict(list)
    for rel, row in active_cache.items():
        _, _, sz, _, _, art, tit, alb, dur, ext = row
        n_tit = normalize_text(tit)
        n_art = normalize_text(art)
        
        if n_tit and len(n_tit) >= 3 and dur > 20:
            item = {
                'path': rel,
                'artist': art or 'Unknown Artist',
                'title': tit,
                'album': alb,
                'duration': dur,
                'ext': ext,
                'size_mb': round(sz / (1024 * 1024), 2)
            }
            # Cluster by normalized title
            by_meta[n_tit].append(item)

    meta_duplicates = []
    for n_tit, flist in by_meta.items():
        if len(flist) > 1:
            # Cluster by duration (+/- 3s) and artist similarity
            subclusters = []
            for item in flist:
                matched = False
                for cluster in subclusters:
                    c_art = normalize_text(cluster[0]['artist'])
                    i_art = normalize_text(item['artist'])
                    same_art = (c_art == i_art) and (c_art != '')
                    dur_match = abs(cluster[0]['duration'] - item['duration']) <= 3.0
                    
                    if (same_art and dur_match) or (dur_match and (not c_art or not i_art or same_art)):
                        cluster.append(item)
                        matched = True
                        break
                if not matched:
                    subclusters.append([item])

            for cluster in subclusters:
                if len(cluster) > 1:
                    # Scoring: Format tier > Metadata Completeness > Folder Depth > File size > Penalize (số)
                    def score(it):
                        e = it['ext']
                        s = 0.0
                        if e in ('.dsf', '.dff'): s += 500.0
                        elif e == '.flac': s += 400.0
                        elif e == '.wav': s += 300.0
                        elif e == '.m4a': s += 200.0
                        else: s += 100.0

                        s += min(it.get('size_mb', 0), 50.0)

                        # Ưu tiên Metadata đầy đủ
                        art = (it.get('artist') or '').strip()
                        tit = (it.get('title') or '').strip()
                        alb = (it.get('album') or '').strip()
                        if tit: s += 50.0
                        if art and art.lower() not in ('unknown', 'unknown artist', 'none'): s += 80.0
                        if alb and alb.lower() not in ('unknown', 'unknown album', 'none'): s += 80.0

                        p_obj = Path(it.get('path', ''))
                        fn = p_obj.name
                        # Mặc định trừ rất nặng bản có (số) trong tên
                        if re.search(r'\(\s*\d+\s*\)', fn) or re.search(r'[-_\s]copy\b', fn, flags=re.I):
                            s -= 2000.0

                        # Ưu tiên nằm trong thư mục album
                        if len(p_obj.parts) >= 3:
                            s += 60.0
                        elif len(p_obj.parts) == 2:
                            s += 30.0
                        else:
                            s -= 40.0

                        return s

                    cluster_sorted = sorted(cluster, key=score, reverse=True)
                    meta_duplicates.append({
                        'artist': cluster_sorted[0]['artist'],
                        'title': cluster_sorted[0]['title'],
                        'recommended_keep': cluster_sorted[0],
                        'duplicates': cluster_sorted[1:]
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
