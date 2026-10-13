// Compare native fixture results with the WebAssembly exports in Node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [bindings, directory] = process.argv.slice(2);
assert(bindings && directory, 'Supply the binding file and the native fixture directory.');
const runtime = require(path.resolve(bindings));
const fixtures = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
assert(fixtures.length > 0, 'Generate the native fixtures before this test.');
for (const name of fixtures) {
  const fixture = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  const bytes = new TextEncoder().encode(fixture.input);
  const session = new runtime.EvaluationSession(bytes);
  try {
    assert.deepStrictEqual(JSON.parse(runtime.rank_word(bytes, fixture.word)), fixture.expected, name);
    assert.deepStrictEqual(JSON.parse(session.rank(fixture.word)), fixture.expected, name);
    assert.deepStrictEqual(JSON.parse(session.rank_with_reviewers(fixture.word, 16)), fixture.reviewers, name);
  } finally {
    session.free();
  }
}
console.log(`Native and WebAssembly rankings agree for ${fixtures.length} signed fixtures.`);
