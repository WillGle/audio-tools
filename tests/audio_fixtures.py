"""Deterministic, self-generated audio only; no copyrighted music is shipped."""
from pathlib import Path
import json
import subprocess
import numpy as np


def ffmpeg(*args):
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *map(str, args)], check=True,
                   capture_output=True, timeout=60)


def generate_fixtures(root: Path, seconds=4):
    root.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(20261016)
    labels = {}

    def save(name, signal, rate, bits=16, **label):
        pcm = root / (name + '.raw')
        scale = 2 ** (bits - 1)
        ints = np.rint(np.clip(signal, -1, 1 - 1 / scale) * scale).astype(np.int64)
        if bits == 24:
            packed = ((ints.reshape(-1, 1) >> np.array([0, 8, 16])) & 255).astype('u1')
            pcm.write_bytes(packed.tobytes())
        else:
            pcm.write_bytes(ints.astype('<i2').tobytes())
        path = root / (name + '.flac')
        ffmpeg('-f', f's{bits}le', '-ar', rate, '-ac', signal.shape[1], '-i', pcm,
               '-c:a', 'flac', '-metadata', 'title=Thử nghiệm 日本語 🎵', path)
        pcm.unlink()
        labels[name] = {'path': path.name, **label}
        return path

    sr = 44100
    t = np.arange(sr * seconds) / sr
    noise = rng.normal(0, .06, (len(t), 2))
    music = noise + .18 * np.sin(2 * np.pi * 997 * t[:, None])
    cd = save('valid_cd', music, sr, label='lossless_control')
    save('mono', music[:, :1], sr, label='lossless_control')
    save('opposite_channels', np.column_stack([music[:, 0], -music[:, 0]]), sr,
         label='lossless_control')
    save('silence', np.zeros_like(music), sr, 24, label='silence_control')
    save('low_level', music * 1e-4, sr, 24, label='lossless_control')
    save('clipped', np.clip(12 * music, -1, 1), sr, label='clipped')
    save('dc_offset', music + .08, sr, label='dc_offset')
    padded = np.rint(music * 32768) / 32768
    save('padded_24', padded, sr, 24, label='padded')
    save('dithered_24', padded + rng.uniform(-1, 1, music.shape) / 2**23, sr, 24,
         label='resolution_unknown')
    for rate in (96000, 192000):
        path = root / f'upsampled_{rate}.flac'
        ffmpeg('-i', cd, '-ar', rate, '-sample_fmt', 's32', '-c:a', 'flac', path)
        labels[path.stem] = {'path': path.name, 'label': 'upsampled'}
    hires = rng.normal(0, .08, (96000 * seconds, 2))
    save('valid_hires', hires, 96000, 24, label='lossless_control')
    for name, cutoff in [('bandlimited', 16000), ('legitimate_lowpass', 20000)]:
        # A brick-wall lowpass applied directly to lossless noise is a false-positive control.
        spec = np.fft.rfft(music, axis=0)
        spec[np.fft.rfftfreq(len(t), 1/sr) > cutoff] = 0
        save(name, np.fft.irfft(spec, n=len(t), axis=0), sr, label='lossless_control')
    for codec, bitrate, ext in [('libmp3lame', '128k', 'mp3'), ('libmp3lame', '320k', 'mp3'),
                                ('aac', '192k', 'm4a')]:
        name = f'{"aac" if codec == "aac" else "mp3"}_{bitrate}'
        encoded = root / (name + '.' + ext)
        try:
            ffmpeg('-i', cd, '-c:a', codec, '-b:a', bitrate, encoded)
        except subprocess.CalledProcessError:
            if codec == 'aac':
                labels[name] = {'label': 'unavailable_encoder'}
                continue
            raise
        dest = root / (name + '.flac')
        ffmpeg('-i', encoded, '-c:a', 'flac', dest)
        labels[name] = {'path': dest.name, 'label': 'transcoded'}
    mixed = root / 'mixed_source.flac'
    ffmpeg('-i', cd, '-i', root / 'mp3_128k.flac', '-filter_complex',
           '[0:a][1:a]concat=n=2:v=0:a=1[out]', '-map', '[out]', '-c:a', 'flac', mixed)
    labels['mixed_source'] = {'path': mixed.name, 'label': 'partially_transcoded'}
    data = cd.read_bytes()
    (root / 'truncated.flac').write_bytes(data[:-max(1000, len(data)//4)])
    labels['truncated'] = {'path': 'truncated.flac', 'label': 'corrupt'}
    (root / 'missing_md5.flac').write_bytes(data[:26] + bytes(16) + data[42:])
    labels['missing_md5'] = {'path': 'missing_md5.flac', 'label': 'lossless_control'}
    ffmpeg('-i', cd, '-c:a', 'alac', root / 'valid_alac.m4a')
    labels['valid_alac'] = {'path': 'valid_alac.m4a', 'label': 'lossless_control'}
    ffmpeg('-i', cd, '-c:a', 'pcm_f32le', root / 'float.wav')
    labels['float'] = {'path': 'float.wav', 'label': 'float_control'}
    (root / 'manifest.json').write_text(json.dumps(labels, indent=2), encoding='utf8')
    return labels


if __name__ == '__main__':
    import sys
    generate_fixtures(Path(sys.argv[1]))
