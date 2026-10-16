from pathlib import Path
import sys
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.audio_fixtures import generate_fixtures


@pytest.fixture(scope='session')
def audio_library(tmp_path_factory):
    root = tmp_path_factory.mktemp('audio')
    return root, generate_fixtures(root)
