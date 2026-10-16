from pathlib import Path


def vault_path(root, value):
    """Resolve paths inside the vault, including symlink targets."""
    root = Path(root).resolve()
    path = (root / value).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError('Đường dẫn phải nằm trong thư viện nhạc')
    return path
