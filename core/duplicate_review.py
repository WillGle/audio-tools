"""Persistent duplicate decisions and recoverable byte-identical archiving."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid

from core.paths import cache_directory, vault_path
from core.vault_tiering import _tiering_lock


def connect():
    conn = sqlite3.connect(cache_directory() / 'duplicate_review.sqlite', timeout=30)
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS decisions (
            vault TEXT, group_key TEXT, decision TEXT NOT NULL,
            PRIMARY KEY(vault, group_key));
        CREATE TABLE IF NOT EXISTS archive_moves (
            id TEXT PRIMARY KEY, vault TEXT NOT NULL, original TEXT NOT NULL,
            destination TEXT NOT NULL, sha256 TEXT NOT NULL);
    ''')
    return conn


def stamp(path):
    st = path.stat()
    return [st.st_size, st.st_mtime_ns, st.st_ctime_ns]


def digest(path):
    before = stamp(path)
    h = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            h.update(chunk)
    if stamp(path) != before:
        raise ValueError('Tệp thay đổi trong lúc kiểm tra; hãy quét lại')
    return h.hexdigest(), before


def mutation_path(root, value):
    path = vault_path(root, value)
    # Journal operations must act on the recorded path, never a symlink target
    # substituted at that path or in one of its parent directories.
    if path != root / value or (root / value).is_symlink():
        raise ValueError('Đường dẫn có symlink hoặc đã đổi vị trí; giữ nguyên tệp')
    return path


def group_key(root, kind, files):
    members = sorted(f if isinstance(f, str) else f['path'] for f in files)
    state = [(name, stamp(vault_path(root, name))) for name in members]
    return hashlib.sha256(json.dumps([kind, state], ensure_ascii=False).encode()).hexdigest()


def apply_decisions(root, groups):
    with closing(connect()) as conn:
        decisions = dict(conn.execute('SELECT group_key,decision FROM decisions WHERE vault=?', (str(Path(root).resolve()),)))
    for kind, entries in groups.items():
        for group in entries:
            group['review_key'] = group_key(root, kind, group['files'])
            group['review_decision'] = decisions.get(group['review_key'])


def save_decision(root, key, decision):
    if decision not in ('keep_both', 'different_edition', 'ignore', None):
        raise ValueError('Quyết định không hợp lệ')
    with _tiering_lock:
        from core.dedup import scan_duplicates
        report = scan_duplicates(root)
        valid = any(g['review_key'] == key for kind in ('byte_duplicates', 'meta_duplicates', 'name_duplicates') for g in report[kind])
        if not valid:
            raise ValueError('Nhóm đã thay đổi; hãy quét lại trước khi lưu quyết định')
        with closing(connect()) as conn:
            if decision is None:
                conn.execute('DELETE FROM decisions WHERE vault=? AND group_key=?', (str(Path(root).resolve()), key))
            else:
                conn.execute('INSERT OR REPLACE INTO decisions VALUES (?,?,?)', (str(Path(root).resolve()), key, decision))
            conn.commit()


def _move_without_overwrite(src, dst):
    # Both paths are in the vault. Hard-link then unlink avoids overwriting a
    # concurrently created destination; cross-filesystem moves fail safely.
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.hardlink_to(src)
    src.unlink()


def archive_duplicates(root, selected=None):
    from core.dedup import scan_duplicates
    root = Path(root).resolve()
    with _tiering_lock:
        report = scan_duplicates(root, force_refresh=True)
        groups = report['byte_duplicates']
        if selected is None:
            selected = [p for g in groups if not g['review_decision'] for p in g['files'][1:]]
        selected = set(selected)
        errors, verified, moved = [], {}, []
        for group in groups:
            paths = set(group['files'])
            chosen = paths & selected
            if not chosen:
                continue
            if group['review_decision']:
                errors.extend(f'{p}: nhóm đã được đánh dấu giữ / bỏ qua' for p in sorted(chosen))
                continue
            keepers = paths - selected
            if not keepers:
                errors.extend(f'{p}: phải giữ ít nhất một bản gốc' for p in sorted(chosen))
                continue
            try:
                keeper = mutation_path(root, sorted(keepers)[0])
                keep_hash, keep_stamp = digest(keeper)
                for name in sorted(chosen):
                    src = mutation_path(root, name)
                    if (root / name).is_symlink() or src == keeper:
                        raise ValueError('Không lưu trữ symlink hoặc bản đang giữ')
                    sha, current_stamp = digest(src)
                    if sha != keep_hash:
                        raise ValueError('Bản phụ không còn giống từng byte với bản giữ')
                    verified[name] = (sha, current_stamp, keeper, keep_stamp)
            except (OSError, ValueError) as exc:
                for name in chosen:
                    verified.pop(name, None)
                    errors.append(f'{name}: {exc}')
        for name in sorted(selected - {p for g in groups for p in g['files']}):
            errors.append(f'{name}: chưa xác minh được bản trùng byte; giữ nguyên tệp')
        with closing(connect()) as conn:
            for name, (sha, current_stamp, keeper, keep_stamp) in verified.items():
                move_id = uuid.uuid4().hex
                try:
                    src = mutation_path(root, name)
                    if mutation_path(root, str(keeper.relative_to(root))) != keeper:
                        raise ValueError('Đường dẫn bản giữ đã thay đổi')
                    if stamp(src) != current_stamp or stamp(keeper) != keep_stamp:
                        raise ValueError('Tệp đã thay đổi; hãy quét lại')
                    destination = str(Path('_Duplicates_Archive') / move_id / name)
                    dst = mutation_path(root, destination)
                    # Commit intent before touching music so restart preserves undo.
                    conn.execute('INSERT INTO archive_moves VALUES (?,?,?,?,?)', (move_id, str(root), name, destination, sha))
                    conn.commit()
                    _move_without_overwrite(src, dst)
                    moved.append(name)
                except (OSError, ValueError) as exc:
                    errors.append(f'{name}: {exc}')
        return {'success': not errors, 'archived_count': len(moved), 'errors': errors,
                'message': f'Đã lưu trữ {len(moved)} bản trùng byte; {len(errors)} lỗi.'}


def restore_archives(root):
    root = Path(root).resolve()
    restored, errors = 0, []
    with _tiering_lock, closing(connect()) as conn:
        rows = conn.execute('SELECT id,original,destination,sha256 FROM archive_moves WHERE vault=? ORDER BY rowid DESC', (str(root),)).fetchall()
        for move_id, original, destination, sha in rows:
            try:
                src, dst = mutation_path(root, destination), mutation_path(root, original)
                if src == dst:
                    raise ValueError('Đường dẫn gốc trùng bản lưu trữ; giữ nhật ký')
                if not src.exists():
                    # Intent was saved but the move did not happen (or undo finished).
                    if not dst.is_file() or digest(dst)[0] != sha:
                        raise ValueError('Không tìm thấy bản lưu trữ còn khớp; giữ nhật ký')
                else:
                    if digest(src)[0] != sha:
                        raise ValueError('Bản lưu trữ đã thay đổi; giữ nguyên tệp')
                    if dst.exists():
                        if not dst.samefile(src):
                            raise ValueError('Đường dẫn gốc đã có tệp; không ghi đè')
                        src.unlink()  # Recover interruption between link and unlink.
                    else:
                        _move_without_overwrite(src, dst)
                    restored += 1
                conn.execute('DELETE FROM archive_moves WHERE id=?', (move_id,))
                conn.commit()
            except (OSError, ValueError) as exc:
                errors.append(f'{original}: {exc}')
    return {'success': not errors, 'restored_count': restored, 'errors': errors,
            'message': f'Đã khôi phục {restored} tệp; {len(errors)} lỗi.'}
