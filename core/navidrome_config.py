"""Private, server-side Navidrome connection settings for this single-user app."""
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import urlsplit


def read_config(cache_dir):
    try:
        return json.loads((Path(cache_dir) / 'navidrome.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def resolve_config(cache_dir, config=None):
    saved = read_config(cache_dir)
    if not config or not config.get('server_url'):
        return saved
    config = dict(config)
    if (config.get('server_url', '').rstrip('/') == saved.get('server_url', '').rstrip('/')
            and config.get('username') == saved.get('username') and not config.get('password')):
        config['password'] = saved.get('password', '')
    return config


def public_config(config):
    return {key: config.get(key, '') for key in ('server_url', 'username')} | {
        'configured': bool(config.get('server_url')),
        'password_saved': bool(config.get('password')),
    }


def write_config(cache_dir, config):
    config = resolve_config(cache_dir, config)
    url = (config.get('server_url') or '').strip().rstrip('/')
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('URL phải là địa chỉ HTTP/HTTPS của Navidrome, không chứa mật khẩu, query hoặc fragment.')
    config = {'server_url': url, 'username': (config.get('username') or '').strip(),
              'password': config.get('password') or ''}
    fd, temporary = tempfile.mkstemp(prefix='.navidrome-', dir=cache_dir)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(config, handle, ensure_ascii=False)
        os.replace(temporary, Path(cache_dir) / 'navidrome.json')
    finally:
        Path(temporary).unlink(missing_ok=True)
    return public_config(config)
