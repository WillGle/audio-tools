"""Bounded, cancellable subprocess IO. No shell and no user-controlled executable."""
from collections import deque
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time


class AnalysisCancelled(Exception):
    pass


class ToolError(Exception):
    pass


def checkpoint(cancel):
    if cancel is not None and cancel.is_set():
        raise AnalysisCancelled('Đã hủy phân tích')


class Process:
    def __init__(self, args, timeout=1800, cancel=None, memory_mb=2048):
        checkpoint(cancel)
        self.cancel = cancel
        self.deadline = time.monotonic() + timeout
        self.errors = deque(maxlen=16)
        # Resource limits run in a fresh interpreter, avoiding unsafe preexec_fn in workers.
        if os.name == 'posix':
            args = [sys.executable, str(Path(__file__).resolve()), str(memory_mb), *args]
        try:
            self.proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, env={**os.environ, 'LC_ALL': 'C'})
        except OSError as exc:
            raise ToolError('Không khởi chạy được công cụ') from exc
        self.q = queue.Queue(maxsize=4)
        self.stop = threading.Event()
        self.stdout_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self.stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self.stdout_thread.start()
        self.stderr_thread.start()

    def _put(self, data):
        while not self.stop.is_set():
            try:
                self.q.put(data, timeout=.1)
                return
            except queue.Full:
                continue

    def _read_stdout(self):
        try:
            while data := self.proc.stdout.read(65536):
                self._put(data)
        finally:
            self._put(None)

    def _read_stderr(self):
        while data := self.proc.stderr.read(4096):
            self.errors.append(data)

    def chunks(self):
        try:
            while True:
                checkpoint(self.cancel)
                if time.monotonic() > self.deadline:
                    raise ToolError('Vượt giới hạn thời gian phân tích')
                try:
                    data = self.q.get(timeout=.1)
                except queue.Empty:
                    continue
                if data is None:
                    # stdout can close before the process exits; keep cancellation responsive.
                    while self.proc.poll() is None:
                        checkpoint(self.cancel)
                        if time.monotonic() > self.deadline:
                            raise ToolError('Vượt giới hạn thời gian phân tích')
                        self.stop.wait(.05)
                    self.stderr_thread.join(timeout=2)
                    return
                yield data
        finally:
            self.close()

    @property
    def stderr(self):
        return b''.join(self.errors).decode('utf8', errors='replace')[-32768:]

    def close(self):
        self.stop.set()
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()
        self.stdout_thread.join(timeout=2)
        self.stderr_thread.join(timeout=2)
        self.proc.stdout.close()
        self.proc.stderr.close()


def run(args, *, timeout=60, cancel=None, max_output=2_000_000, memory_mb=2048):
    proc = Process(args, timeout, cancel, memory_mb)
    data = bytearray()
    try:
        for chunk in proc.chunks():
            data.extend(chunk)
            if len(data) > max_output:
                raise ToolError('Đầu ra công cụ vượt giới hạn')
    finally:
        proc.close()
    return proc.proc.returncode, bytes(data), proc.stderr


if __name__ == '__main__':
    # CLI used only internally with fixed executable names and argument arrays.
    import resource
    mb = int(sys.argv[1]) * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (mb, mb))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.execvp(sys.argv[2], sys.argv[2:])
