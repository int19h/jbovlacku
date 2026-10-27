import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTextOrthography,
  type OrthographyOptions,
} from "../src/orthography.ts";

const images = (input: string, options?: OrthographyOptions) =>
  normalizeTextOrthography(input, options).runs.map(({ text, foreign }) => ({
    text,
    foreign,
  }));
const ordinary = (...texts: string[]) =>
  texts.map((text) => ({ text, foreign: false }));

// These examples follow the pinned phoneme grammars named in orthography.ts.
test("text orthography folds capital runs but keeps accents and single groups", () => {
  assert.deepEqual(
    images("KLAMA MI .DJORdj. KLÁMA ĄKLÁMA AÏ AḮ"),
    ordinary("klama", "mI", "djOrdj", "klAma", "aiklAma", "a'i", "a'I"),
  );
  assert.deepEqual(
    images("klAma klÁma", { features: ["case-insensitive"] }),
    ordinary("klama", "klAma"),
  );
  assert.deepEqual(
    images("klAma", {
      features: ["case-insensitive"],
      withoutFeatures: ["case-insensitive"],
    }),
    ordinary("klAma"),
  );
});

test("text orthography maps Latin marks and distinguishes glide constraints", () => {
  assert.deepEqual(
    images("qwa maĭ Ŭá ɩa ẅa ą́ ę ǫ ǎ ꜷ ćŝ aï"),
    ordinary(
      "qwa",
      "maɩ",
      "ʋA",
      "qa",
      "'wa",
      "Ai",
      "ei",
      "oi",
      "au",
      "au",
      "cs",
      "a'i",
    ),
  );
  assert.deepEqual(images("a\u0328\u030c"), [
    { text: "a\u0328\u030c", foreign: true },
  ]);
  assert.deepEqual(images("mi\u093e"), ordinary("mi"));
});

test("text orthography maps Cyrillic vowels with script-specific joins", () => {
  assert.deepEqual(
    images("маи ма,и май мёи Ќӑ ґә һ"),
    ordinary("ma'i", "ma'i", "mai", "me'i", "ka", "gy", "'"),
  );
  assert.deepEqual(
    images("мои МАИ май", { features: ["cll-cyrillic"] }),
    ordinary("moi", "mAI", "mai"),
  );
  assert.deepEqual(images("ӏмаиӏ"), ordinary("ma'i"));
  assert.deepEqual(images("ӏмаиӏ", { features: ["cll-cyrillic"] }), [
    { text: "ӏмаиӏ", foreign: true },
  ]);
});

test("digits expand with empty spans for inserted phonemes", () => {
  const [run] = normalizeTextOrthography("3.14").runs;
  assert.equal(run.text, "cipipavo");
  assert.deepEqual(run.spans, [
    { start: 0, end: 1 },
    { start: 1, end: 1 },
    { start: 1, end: 2 },
    { start: 2, end: 2 },
    { start: 2, end: 3 },
    { start: 3, end: 3 },
    { start: 3, end: 4 },
    { start: 4, end: 4 },
  ]);
  assert.deepEqual(
    images("2,.3 2.,3 2~.3"),
    ordinary("re", "ci", "re", "ci", "re", "ci"),
  );
});

test("quotes use letter neighbors across ignored characters", () => {
  assert.deepEqual(
    images("'klama' ‘klama’ ko~'a lé'i mi''do mi'\u0301"),
    ordinary("klama", "klama", "ko'a", "lE'i", "mi", "do", "mi"),
  );
  assert.deepEqual(images("ß'a ß'٣"), [
    { text: "ß'a", foreign: true },
    { text: "ß", foreign: true },
    { text: "٣", foreign: true },
  ]);
  assert.deepEqual(images("a,\u0301'a"), [
    { text: "a,\u0301", foreign: true },
    ...ordinary("a"),
  ]);
});

test("punctuation separates runs while silent and format marks join them", () => {
  assert.deepEqual(
    images(
      "gen·cmu gen·cmu bro~da mi\u200bklama mi\u200dklama mi☀do mi\u0600do",
    ),
    ordinary(
      "gencmu",
      "gencmu",
      "broda",
      "mi",
      "klama",
      "miklama",
      "mi",
      "do",
      "mi",
      "do",
    ),
  );
  assert.deepEqual(images("mi½klama mi\u0000do クリボー"), [
    { text: "mi½klama", foreign: true },
    { text: "mi\u0000do", foreign: true },
    { text: "クリボ", foreign: true },
  ]);
  assert.deepEqual(images("~~~ , \u200d"), []);
  assert.deepEqual(images("mi ाklama"), [
    ...ordinary("mi"),
    { text: "ाklama", foreign: true },
  ]);
});

test("both zbalermorna encodings preserve the original UTF-16 spans", () => {
  for (const shift of [0, 0xe3b20]) {
    const z = (...codes: number[]) =>
      String.fromCodePoint(...codes.map((code) => code + shift));
    const input = z(
      0xed89,
      0xed82,
      0xed84,
      0xeda0,
      0xed98,
      0xed87,
      0xeda0,
      0xed89,
    );
    assert.deepEqual(images(input), ordinary("klAma"));
    const [run] = normalizeTextOrthography(input).runs;
    const width = shift ? 2 : 1;
    assert.deepEqual(run.spans[2], { start: 3 * width, end: 5 * width });
    assert.deepEqual(images(z(0xed8b, 0xeda0)), ordinary("a'"));
    assert.deepEqual(images(z(0xeda6, 0xed98)), ordinary("Ai"));
    for (const codes of [
      [0xed8b, 0xeda6],
      [0xedaa, 0xed98],
      [0xedb6],
      [0xed8d],
      [0xed9c],
    ]) {
      const text = z(...codes);
      assert.deepEqual(images(text), [{ text, foreign: true }]);
    }
  }
});

test("decomposed accents and inserted apostrophes retain source offsets", () => {
  const [run] = normalizeTextOrthography("мaï\u0301").runs;
  assert.equal(run.text, "ma'I");
  assert.deepEqual(run.spans, [
    { start: 0, end: 1 },
    { start: 1, end: 2 },
    { start: 2, end: 2 },
    { start: 2, end: 4 },
  ]);
});
