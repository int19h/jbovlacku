"""Run serial synthetic measurements after the two release examples build."""
import argparse
import os
import pathlib
import platform
import subprocess

root = pathlib.Path(__file__).resolve().parents[3]
target = pathlib.Path(os.environ.get('CARGO_TARGET_DIR', root / 'target'))
if not target.is_absolute():
    target = root / target
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=pathlib.Path, help='A new file for measurement results.')
output = parser.parse_args().output.expanduser().resolve()
scenarios = [('contributors', 32, 1_000_000), ('contributors', 512, 1_000_000),
             ('contributors', 1000, 1), ('contributors', 1000, 1_000_000),
             ('hostile', 16, 1000), ('hostile', 32, 1),
             ('hostile', 32, 1_000_000), ('hostile', 64, 1_000_000),
             ('hostile', 128, 50_000), ('weighted', 8, 1), ('weighted', 16, 1)]
native = target / 'release/examples/feasibility'
wasm = target / 'wasm32-unknown-unknown/release/examples/feasibility_wasm.wasm'
if not native.is_file() or not wasm.is_file():
    parser.error('Build both release examples in CARGO_TARGET_DIR before this measurement.')
output.parent.mkdir(parents=True, exist_ok=True)
try:
    log_file = output.open('x')
except FileExistsError:
    parser.error('The output file already exists. Select a new path to preserve earlier evidence.')
with log_file as log:
    def emit(text):
        print(text, flush=True)
        log.write(text + '\n')
        log.flush()
    emit('Synthetic measurements. Single serial run per scenario. Timings include graph construction, exact ranking, 32 candidate scores, 496 candidate differences, and layers.')
    emit('Host: ' + platform.platform())
    emit(subprocess.check_output(['rustc', '--version'], text=True).strip())
    emit(subprocess.check_output(['node', '--version'], text=True).strip())
    runner = root / 'crates/jvc-rank/examples/measure-wasm.cjs'
    for command in [[str(native), 'oracle'], ['node', str(runner), str(wasm), 'oracle']]:
        result = subprocess.run(command, text=True, capture_output=True, timeout=60)
        emit('oracle: ' + result.stdout.strip())
        assert result.returncode == 0, result.stderr
    for kind, n, budget in scenarios:
        args = [kind, str(n), str(budget)]
        native_result = subprocess.run(['/usr/bin/time', '-f', 'peak_rss_kib=%M cpu_seconds=%U', str(native), *args], text=True, capture_output=True, timeout=60)
        wasm_result = subprocess.run(['node', str(runner), str(wasm), *args], text=True, capture_output=True, timeout=60)
        emit(f'\nscenario={kind} actors={n} budget={budget}')
        emit('native: ' + native_result.stdout.strip() + ' ' + native_result.stderr.strip())
        emit('wasm: ' + wasm_result.stdout.strip())
        assert native_result.returncode == 0, native_result.stderr
        assert wasm_result.returncode == 0, wasm_result.stderr
        for field in ['actors','edges','work','stages','peak_prefixes','bits','comparisons','strict','ties','digest']:
            a = dict(item.split('=', 1) for item in native_result.stdout.split())[field]
            b = dict(item.split('=', 1) for item in wasm_result.stdout.split())[field]
            assert a == b, (field, a, b)
    result = subprocess.run([str(native), 'hostile', '512', '1'], text=True, capture_output=True, timeout=60)
    emit('\nresource demonstration: ' + result.stderr.strip())
    assert result.returncode == 2 and 'edges' in result.stderr
