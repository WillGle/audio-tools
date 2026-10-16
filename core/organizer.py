"""Plan metadata-based moves without guessing missing titles from filenames."""
import os
from collections import Counter
from pathlib import Path

import mutagen

from core.paths import vault_path
from core.vault_tiering import AUDIO_EXTENSIONS, clean_name

ROLLBACK_NAME = '.metadata_organize_rollback.json'


def file_stamp(path):
    stat = path.stat()
    return [stat.st_size, stat.st_mtime_ns, stat.st_ino]


def metadata_plan(root, folder=''):
    root = Path(root).resolve()
    source = vault_path(root, folder) if folder.strip() not in ('', '.') else root
    if not source.is_dir():
        raise ValueError('Không tìm thấy thư mục trong kho nhạc')
    items = []
    for directory, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and
                         d not in {'_Duplicates_Archive', '_Vault_3_Tier_Symlinks'} and
                         not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            path = Path(directory) / name
            if path.suffix.lower() not in AUDIO_EXTENSIONS or path.is_symlink():
                continue
            item = {'original_path': str(path.relative_to(root)), 'dest_path': None,
                    'artist': '', 'album': '', 'title': '', 'status': 'REVIEW', 'reason': ''}
            try:
                vault_path(root, path)
                item['stamp'] = file_stamp(path)
                audio = mutagen.File(path, easy=True)
                if audio is None:
                    raise ValueError('Không đọc được metadata định dạng này')

                def tag(key):
                    values = audio.get(key, [])
                    return str(values[0]).strip() if values else ''

                title, artist, album = tag('title'), tag('albumartist') or tag('artist'), tag('album')
                item.update(title=title, artist=artist, album=album)
                if not title or not artist or title.lower() in {'unknown', 'untitled', 'no title'}:
                    item['reason'] = 'Thiếu tên bài hoặc nghệ sĩ trong tag; giữ nguyên để kiểm tra.'
                else:
                    track = tag('tracknumber').split('/')[0]
                    disc = tag('discnumber').split('/')[0]
                    number = f'{int(track):02d} - ' if track.isdigit() and int(track) > 0 else ''
                    # Disc prefix prevents two discs' track 01 from sharing a destination.
                    if disc.isdigit() and int(disc) > 1:
                        number = f'D{int(disc):02d} - {number}'
                    destination = root / clean_name(artist) / clean_name(album or 'Chưa rõ album') / (number + clean_name(title) + path.suffix)
                    destination = vault_path(root, destination)
                    item['dest_path'] = str(destination.relative_to(root))
                    item['status'] = 'UNCHANGED' if destination == path else 'READY'
                    item['reason'] = 'Đã đúng vị trí.' if destination == path else 'Đổi tên và sắp xếp từ tag.'
                    if not album:
                        item['reason'] += ' Thiếu album: dùng nhóm Chưa rõ album.'
                    if destination != path and (destination.exists() or destination.is_symlink()):
                        item.update(status='CONFLICT', reason='Đích đã tồn tại; bỏ qua, không ghi đè.')
            except Exception as exc:
                item.update(status='REVIEW', reason=f'Không lập được đường dẫn: {exc}')
            items.append(item)
    destinations = Counter(item['dest_path'].casefold() for item in items if item['dest_path'])
    for item in items:
        if item['status'] == 'READY' and destinations[item['dest_path'].casefold()] > 1:
            item.update(status='CONFLICT', reason='Nhiều tệp cùng đường dẫn đích; cần chọn bản giữ lại.')
    counts = Counter(item['status'] for item in items)
    return {'folder': str(source.relative_to(root)), 'items': items, 'total': len(items),
            'counts': {key: counts[key] for key in ('READY', 'REVIEW', 'CONFLICT', 'UNCHANGED')}}
