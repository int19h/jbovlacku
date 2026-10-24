"""Run the same format corpus in native Rust and Chromium."""
import functools
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import threading

root = pathlib.Path(__file__).resolve().parents[3]
target = pathlib.Path(os.environ.get('CARGO_TARGET_DIR', root / 'target')).resolve()
corpus = root / 'crates/jvc-core/tests/fixtures/corpus.json'
env = dict(os.environ, CARGO_TARGET_DIR=str(target))
def run(args, **kwargs):
    return subprocess.run(args, cwd=root, env=env, check=True, text=True, **kwargs)
native = run(['cargo','run','-p','jvc-core','--example','check_corpus','--jobs','2','--',str(corpus)],capture_output=True)
run(['cargo','build','-p','jvc-core','--target','wasm32-unknown-unknown','--release','--jobs','2'])
site = target / 'browser-parity'
site.mkdir(parents=True, exist_ok=True)
run([os.environ.get('WASM_BINDGEN', 'wasm-bindgen'),'--target','web','--out-dir',str(site / 'wasm'),str(target / 'wasm32-unknown-unknown/release/jvc_core.wasm')])
shutil.copy(corpus, site / 'corpus.json')
shutil.copy(root / 'crates/jvc-core/tests/browser-parity.html', site / 'index.html')
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
server = http.server.ThreadingHTTPServer(('127.0.0.1',0), functools.partial(QuietHandler,directory=site))
thread = threading.Thread(target=server.serve_forever,daemon=True)
thread.start()
try:
    browser = run(['node',str(root / 'crates/jvc-core/tests/browser-driver.mjs'),f'http://127.0.0.1:{server.server_port}/'],capture_output=True,timeout=60)
    result = json.loads(browser.stdout)
    assert result['status']=='passed', result
    assert result['results']==json.loads(native.stdout), 'native and browser outputs differ'
    (target / 'browser-parity-result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'status':'passed','cases':result['cases'],'native_browser_equal':True}))
finally:
    server.shutdown()
