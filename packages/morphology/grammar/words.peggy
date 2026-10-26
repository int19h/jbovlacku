// Derived from ilmentufa camxes-morpho.pegjs and camxes-exp.pegjs.
// Revision 778ea138f7d150121ca722db7536ce3b123943ac. MIT License.
// Copyright (c) 2013, 2014 Masato Hagiwara.
// Copyright (c) 2014 lagleki, ilmen, and other contributors.
// See ../THIRD-PARTY-NOTICES.md and changes.md for sources and changes.
{
  function node(rule, range, children) {
    function collect(value) {
      if (!value) return [];
      if (Array.isArray(value)) return value.flatMap(collect);
      return typeof value === "object" ? [value] : [];
    }
    return { rule, start: range.start.offset, end: range.end.offset,
      children: collect(children) };
  }
}

words = gap? ws:(w:word gap? { return w; })+ !. { return ws; }
word = cmevla / cmavo / gismu / lujvo / fuhivla
gap = (comma* space_char)+

cmevla = expr:(jbocme / zifcme) { return node("cmevla", location(), expr); }

zifcme = expr:(!h (nucleus / glide / h / consonant !pause / digit)* consonant &pause) { return null; }

jbocme = expr:(&zifcme (any_syllable / digit)+ &pause) { return null; }

cmavo = expr:(!cmevla !CVCy_lujvo cmavo_form &post_word) { return node("cmavo", location(), expr); }

CVCy_lujvo = expr:(CVC_rafsi y h? initial_rafsi* brivla_core / stressed_CVC_rafsi y short_final_rafsi) { return null; }

cmavo_form = expr:(y+ !y !h / !h !cluster onset (cmavo_nucleus h)* cmavo_last / digit) { return null; }

brivla = expr:(!cmavo !slihykru initial_rafsi* brivla_core) { return node("brivla", location(), expr); }

brivla_core = expr:(fuhivla / gismu / CVV_final_rafsi / stressed_initial_rafsi short_final_rafsi) { return node("brivla_core", location(), expr); }

stressed_initial_rafsi = expr:(stressed_extended_rafsi / stressed_y_rafsi / stressed_y_less_rafsi) { return node("stressed_initial_rafsi", location(), expr); }

initial_rafsi = expr:(extended_rafsi / y_rafsi / !any_fuhivla_rafsi y_less_rafsi !any_fuhivla_rafsi) { return node("initial_rafsi", location(), expr); }

any_fuhivla_rafsi = expr:(fuhivla / fuhivla_rafsi / stressed_fuhivla_rafsi) { return null; }

fuhivla = begin:position exclusion:(&rafsi_string { return true; })?
  expr:(!cgv_rafsi_continuation brivla_head stressed_syllable consonantal_syllable* final_syllable)
  end:position &{
    const form = input.slice(begin, end);
    return /[bcdfgjklmnprstvxz]{2}/i.test(form)
      && (!exclusion || /[bcdfgjklmnprstvxz][iu][aeiouy]/i.test(form));
  } { return node("fuhivla", location(), expr); }

stressed_extended_rafsi = expr:(stressed_hy_rafsi / stressed_fuhivla_rafsi) { return node("stressed_extended_rafsi", location(), expr); }

extended_rafsi = expr:(hy_rafsi / fuhivla_rafsi) { return node("extended_rafsi", location(), expr); }

stressed_fuhivla_rafsi = expr:(fuhivla_head stressed_syllable consonantal_syllable* onset y) { return node("stressed_fuhivla_rafsi", location(), expr); }

fuhivla_rafsi = expr:(&unstressed_syllable fuhivla_head onset y h?) { return node("fuhivla_rafsi", location(), expr); }

fuhivla_head = expr:(!rafsi_string brivla_head) { return null; }

brivla_head = expr:(!cmavo !slinkuhi !h &brivla_onset unstressed_syllable*) { return null; }

slinkuhi = expr:(!rafsi_string consonant rafsi_string) { return null; }

rafsi_string = expr:(y_less_rafsi* (gismu / CVV_final_rafsi / stressed_y_less_rafsi short_final_rafsi / y_rafsi / stressed_y_rafsi / stressed_y_less_rafsi? initial_pair y / hy_rafsi / stressed_hy_rafsi)) { return null; }

slihykru = expr:((CCV_rafsi / stressed_CCV_rafsi) h y brivla_onset) { return null; }

gismu = expr:((initial_pair stressed_vowel / consonant stressed_vowel consonant) &final_syllable consonant vowel &post_word) { return node("gismu", location(), expr); }

CVV_final_rafsi = expr:(consonant stressed_vowel h &final_syllable vowel &post_word) { return node("CVV_final_rafsi", location(), expr); }

short_final_rafsi = expr:(&final_syllable (consonant diphthong / initial_pair vowel) &post_word) { return node("short_final_rafsi", location(), expr); }

stressed_y_rafsi = expr:((stressed_long_rafsi / stressed_CVC_rafsi) y) { return node("stressed_y_rafsi", location(), expr); }

stressed_y_less_rafsi = expr:(stressed_CVC_rafsi !y / stressed_CCV_rafsi / stressed_CVV_rafsi) { return node("stressed_y_less_rafsi", location(), expr); }

stressed_long_rafsi = expr:(initial_pair stressed_vowel consonant / consonant stressed_vowel consonant consonant) { return node("stressed_long_rafsi", location(), expr); }

stressed_CVC_rafsi = expr:(consonant stressed_vowel consonant) { return node("stressed_CVC_rafsi", location(), expr); }

stressed_CCV_rafsi = expr:(initial_pair stressed_vowel) { return node("stressed_CCV_rafsi", location(), expr); }

stressed_CVV_rafsi = expr:(consonant (unstressed_vowel h stressed_vowel / stressed_diphthong) r_hyphen?) { return node("stressed_CVV_rafsi", location(), expr); }

y_rafsi = expr:((long_rafsi / CVC_rafsi) y h?) { return node("y_rafsi", location(), expr); }

y_less_rafsi = expr:(!y_rafsi !stressed_y_rafsi !hy_rafsi !stressed_hy_rafsi (CVC_rafsi / CCV_rafsi / CVV_rafsi) !h) { return node("y_less_rafsi", location(), expr); }

hy_rafsi = expr:((long_rafsi unstressed_vowel / CCV_rafsi / CVV_rafsi) h y h?) { return node("hy_rafsi", location(), expr); }

stressed_hy_rafsi = expr:((long_rafsi stressed_vowel / stressed_CCV_rafsi / stressed_CVV_rafsi) h y) { return node("stressed_hy_rafsi", location(), expr); }

long_rafsi = expr:(initial_pair unstressed_vowel consonant / consonant unstressed_vowel consonant consonant) { return node("long_rafsi", location(), expr); }

CVC_rafsi = expr:(consonant unstressed_vowel consonant) { return node("CVC_rafsi", location(), expr); }

CCV_rafsi = expr:(initial_pair unstressed_vowel) { return node("CCV_rafsi", location(), expr); }

CVV_rafsi = expr:(consonant (unstressed_vowel h unstressed_vowel / unstressed_diphthong) r_hyphen?) { return node("CVV_rafsi", location(), expr); }

r_hyphen = expr:(r &consonant / n &r) { return node("r_hyphen", location(), expr); }

final_syllable = expr:(brivla_onset !y !stressed nucleus !cmevla &post_word) { return null; }

stressed_syllable = expr:(&stressed syllable / syllable &stress) { return null; }

stressed_diphthong = expr:(&stressed diphthong / diphthong &stress) { return null; }

stressed_vowel = expr:(&stressed vowel / vowel &stress) { return null; }

unstressed_syllable = expr:(!stressed syllable !stress / consonantal_syllable) { return null; }

unstressed_diphthong = expr:(!stressed diphthong !stress) { return null; }

unstressed_vowel = expr:(!stressed vowel !stress) { return null; }

stress = expr:((consonant / glide)* h? y? syllable pause) { return null; }

stressed = expr:(brivla_onset comma* [AEIOU]) { return null; }

any_syllable = expr:(brivla_onset nucleus coda? / consonantal_syllable) { return null; }

syllable = expr:(brivla_onset !y nucleus coda?) { return null; }

consonantal_syllable = expr:(consonant &syllabic coda) { return null; }

coda = expr:(!any_syllable consonant &any_syllable / syllabic? consonant? &pause) { return null; }

onset = expr:(h / glide / initial) { return null; }

nucleus = expr:(vowel / diphthong / y !nucleus) { return null; }

glide = expr:((i / u) &nucleus !glide) { return null; }

diphthong = expr:((a u !u / (a i / e i / o i) !i) !nucleus) { return null; }

vowel = expr:((a / e / i / o / u) !nucleus) { return null; }

a = expr:(comma* [aA]) { return null; }

e = expr:(comma* [eE]) { return null; }

i = expr:(comma* [iI]) { return null; }

o = expr:(comma* [oO]) { return null; }

u = expr:(comma* [uU]) { return null; }

y = expr:(comma* [yY] !(!y nucleus)) { return null; }

cluster = expr:(consonant consonant+) { return null; }

initial_pair = expr:(&initial consonant consonant !consonant) { return null; }

initial = expr:((affricate / sibilant? other? liquid?) !consonant !glide) { return null; }

affricate = expr:(t c / t s / d j / d z) { return null; }

liquid = expr:(l / r) { return null; }

other = expr:(p / t !l / k / f / x / b / d !l / g / v / m / n !liquid) { return null; }

sibilant = expr:(c / s !x / (j / z) !n !liquid) { return null; }

consonant = expr:(voiced / unvoiced / syllabic) { return null; }

syllabic = expr:(l / m / n / r) { return null; }

voiced = expr:(b / d / g / j / v / z) { return null; }

unvoiced = expr:(c / f / k / p / s / t / x) { return null; }

l = expr:(comma* [lL] !h !l) { return null; }

m = expr:(comma* [mM] !h !m) { return null; }

n = expr:(comma* [nN] !h !n !affricate) { return null; }

r = expr:(comma* [rR] !h !r) { return null; }

b = expr:(comma* [bB] !h !b !unvoiced) { return null; }

d = expr:(comma* [dD] !h !d !unvoiced) { return null; }

g = expr:(comma* [gG] !h !g !unvoiced) { return null; }

v = expr:(comma* [vV] !h !v !unvoiced) { return null; }

j = expr:(comma* [jJ] !h !j !z !unvoiced) { return null; }

z = expr:(comma* [zZ] !h !z !j !unvoiced) { return null; }

s = expr:(comma* [sS] !h !s !c !voiced) { return null; }

c = expr:(comma* [cC] !h !c !s !x !voiced) { return null; }

x = expr:(comma* [xX] !h !x !c !k !voiced) { return null; }

k = expr:(comma* [kK] !h !k !x !voiced) { return null; }

f = expr:(comma* [fF] !h !f !voiced) { return null; }

p = expr:(comma* [pP] !h !p !voiced) { return null; }

t = expr:(comma* [tT] !h !t !voiced) { return null; }

h = expr:(comma* ['h] &nucleus) { return null; }

digit = expr:(comma* [0123456789] !h !nucleus) { return null; }

post_word = expr:(pause / lojban_word) { return null; }

pause = expr:(comma* space_char+ / EOF) { return null; }

EOF = expr:(comma* !.) { return null; }

comma = expr:([,]) { return null; }

lujvo = expr:(!gismu !fuhivla brivla) { return node("lujvo", location(), expr); }

lojban_word = expr:(cmevla / cmavo / brivla) { return null; }

space_char = expr:([.\t\n\r?!\u0020]) { return null; }

cmavo_nucleus = expr:(diphthong_letters / vowel_letter / y !nucleus) { return null; }

cmavo_last = expr:(!stressed cmavo_nucleus / cmavo_nucleus !cluster) { return null; }

diphthong_letters = expr:(a i !i / a u !u / e i !i / o i !i) { return null; }

vowel_letter = expr:(a / e / i / o / u) { return null; }

initial_parts = expr:(sibilant? other? liquid?) { return null; }

cgv_initial = expr:((affricate / initial_parts) !consonant) { return null; }

cgv_onset = expr:(begin:position cgv_initial end:position &{ return end > begin; } glide) { return null; }

brivla_onset = expr:(onset / cgv_onset) { return null; }

position = &{ return true; } { return location().start.offset; }

cgv_form = expr:(&{ return /[bcdfgjklmnprstvxz][iu][aeiouy]/i.test(input.slice(location().start.offset)); }) { return null; }

cgv_cluster = expr:(&{ return /[bcdfgjklmnprstvxz]{2}/i.test(input.slice(location().start.offset)); }) { return null; }

cgv_rafsi_continuation = expr:((CVC_rafsi / CCV_rafsi / stressed_CVC_rafsi / stressed_CCV_rafsi) !r consonant glide) { return null; }
