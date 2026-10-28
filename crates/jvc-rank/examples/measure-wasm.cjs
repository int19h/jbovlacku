// Run the exact Rust engine through WebAssembly without a browser dependency.
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
(async () => {
  const path = process.argv[2];
  const scenario = process.argv[3] === 'weighted' ? 2 : Number(process.argv[3] === 'hostile');
  const n = Number(process.argv[4]);
  const work = Number(process.argv[5]);
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(path), {});
  const api = instance.exports;
  if (process.argv[3] === 'oracle') {
    if (api.run_oracle_suite() !== 1) throw new Error('oracle failed');
    console.log('oracle passed');
    return;
  }
  const start = performance.now();
  if (api.benchmark(scenario, n, work) !== 1) throw new Error('ranking unavailable');
  const names = ['actors','edges','work','stages','exact','peak_prefixes','bits','comparisons','strict','ties'];
  const fields = names.map((name, index) => `${name}=${api.metric(index)}`);
  fields.push(`digest=${BigInt.asUintN(64, api.metric(10)).toString(16).padStart(16,'0')}`);
  fields.push(`milliseconds=${(performance.now() - start).toFixed(3)}`);
  fields.push(`linear_memory_bytes=${api.memory.buffer.byteLength}`);
  console.log(fields.join(' '));
})().catch(error => { console.error(error.message); process.exit(2); });
