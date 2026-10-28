from pathlib import Path
import os


def cache_directory():
    default = Path('/tmp/audio-tools/cache') if os.environ.get('VERCEL') else Path(__file__).resolve().parent.parent / 'cache'
    path = Path(os.environ.get('AUDIO_TOOLS_CACHE_DIR', str(default))).expanduser().resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def vault_path(root, value):
    """Resolve paths inside the vault, including symlink targets."""
    root = Path(root).resolve()
    path = (root / value).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError('Đường dẫn phải nằm trong thư viện nhạc')
    return path
