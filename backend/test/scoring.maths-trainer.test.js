'use strict';
// Maths Trainer's pure core (docs/minigames-roadmap.md Part A).
//
// Two of these suites exist because the design mockups broke the rules they
// assert, before any code was written:
//
//  * "no arithmetic shortcut" — every treble is a multiple of 3 and every double
//    is even, so an option set that mixes shapes can be narrowed, or solved
//    outright, by a player who knows only that. `D17 -> 34 · 36 · 28 · 51` looks
//    perfectly reasonable and is answerable without knowing D17, because 51 is
//    the only odd option. A counting question is the same trap one level up: the
//    parity of T17 + 13 + D19 is derivable without knowing ANY of the three
//    values, so an odd option in that answer set is a free elimination.
//  * "no positional bias" — a generator that puts the truth in slot 2 slightly
//    too often teaches players the generator. Invisible to inspection.
//
// The instant threshold gets its own suite because it is the mode's whole thesis:
// a right answer that took four seconds means the player computed the value
// rather than recalled it, and correctness alone cannot tell those apart.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../frontend/scoring.js');

// A deterministic rng, so every assertion below is about the generator rather
// than about luck. Mirrors how pickCheckoutTarget()'s own tests inject one.
function seeded(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}

const EASY = S.mathsSegmentPool('easy');
const HARD = S.mathsSegmentPool('hard');

describe('segment values and words', () => {
  test('every label dartLabel() can produce resolves to the right number', () => {
    assert.equal(S.mathsSegmentValue('T19'), 57);
    assert.equal(S.mathsSegmentValue('T20'), 60);
    assert.equal(S.mathsSegmentValue('D17'), 34);
    assert.equal(S.mathsSegmentValue('13'), 13);
    assert.equal(S.mathsSegmentValue('25'), 25);
    assert.equal(S.mathsSegmentValue('Bull'), 50);
  });

  test('nonsense is null rather than NaN', () => {
    for (const bad of ['', 'X4', 'T21', 'D0', 'T', 'treble 19', '99']) {
      assert.equal(S.mathsSegmentValue(bad), null, `${JSON.stringify(bad)} should not parse`);
    }
  });

  test('the spoken form is what the question line needs', () => {
    assert.equal(S.mathsSegmentWords('T19'), 'treble 19');
    assert.equal(S.mathsSegmentWords('D7'), 'double 7');
    assert.equal(S.mathsSegmentWords('13'), '13');
    assert.equal(S.mathsSegmentWords('Bull'), 'the bull');
  });
});

describe('the segment pool', () => {
  test('Easy is exactly the doubles and trebles of 10-20', () => {
    assert.equal(EASY.length, 22, 'eleven numbers, two rings each');
    for (const seg of EASY) {
      const m = /^([TD])(\d{1,2})$/.exec(seg);
      assert.ok(m, `${seg} should be a double or a treble`);
      const n = Number(m[2]);
      assert.ok(n >= 10 && n <= 20, `${seg} is outside 10-20`);
    }
  });

  test('Hard never contains a plain single', () => {
    // The pool-narrowing decision, asserted rather than trusted to stay: singles
    // are already known to anyone who can read, so including them would dilute
    // every session with questions that need no practice — and would make
    // "segments known cold" look better as it got less meaningful.
    for (const seg of HARD) {
      if (seg === '25') continue;   // the outer bull is a genuine recall item
      assert.ok(/^([TD]\d{1,2}|Bull)$/.test(seg), `${seg} is a plain single`);
    }
  });

  test('Hard is a superset of Easy, so progress carries over', () => {
    for (const seg of EASY) assert.ok(HARD.includes(seg), `Hard dropped ${seg}`);
    assert.ok(HARD.length > EASY.length);
  });
});

describe('question generation', () => {
  test('a segment question always comes from its difficulty pool', () => {
    const rng = seeded(7);
    for (let i = 0; i < 400; i++) {
      for (const difficulty of ['easy', 'hard']) {
        const q = S.pickMathsQuestion(rng, { questionType: 'segment', difficulty });
        assert.equal(q.segments.length, 1);
        assert.ok(S.mathsSegmentPool(difficulty).includes(q.prompt), `${q.prompt} not in ${difficulty} pool`);
        assert.equal(q.answer, S.mathsSegmentValue(q.prompt));
      }
    }
  });

  test('counting carries the right dart count for its difficulty', () => {
    const rng = seeded(11);
    for (let i = 0; i < 300; i++) {
      assert.equal(S.pickMathsQuestion(rng, { questionType: 'counting', difficulty: 'easy' }).segments.length, 2);
      assert.equal(S.pickMathsQuestion(rng, { questionType: 'counting', difficulty: 'hard' }).segments.length, 3);
    }
  });

  test("a counting answer is its darts' true sum, and never above 180", () => {
    const rng = seeded(13);
    for (let i = 0; i < 500; i++) {
      const q = S.pickMathsQuestion(rng, { questionType: 'counting', difficulty: 'hard' });
      assert.equal(q.answer, q.segments.reduce((t, s) => t + S.mathsSegmentValue(s), 0));
      assert.ok(q.answer >= 3 && q.answer <= 180, `${q.prompt} = ${q.answer}`);
    }
  });

  test('a prompt round-trips through mathsQuestionFromPrompt', () => {
    // This is the server's re-derivation path: it recomputes the answer from the
    // stored prompt rather than trusting the client's `correct` flag.
    const rng = seeded(17);
    for (let i = 0; i < 200; i++) {
      for (const questionType of ['segment', 'counting']) {
        const q = S.pickMathsQuestion(rng, { questionType, difficulty: 'hard' });
        const back = S.mathsQuestionFromPrompt(q.prompt, questionType);
        assert.deepEqual(back.segments, q.segments);
        assert.equal(back.answer, q.answer);
      }
    }
  });

  test('a malformed prompt is rejected, not silently scored', () => {
    for (const bad of ['', 'T21', 'T19,X4', 'nonsense']) {
      assert.equal(S.mathsQuestionFromPrompt(bad, 'segment'), null, `${JSON.stringify(bad)} should not parse`);
    }
  });
});

describe('the four options — no shortcut, no bias', () => {
  const everyQuestion = () => {
    const qs = [];
    for (const seg of HARD) qs.push(S.mathsQuestionFromPrompt(seg, 'segment'));
    const rng = seeded(23);
    for (let i = 0; i < 120; i++) qs.push(S.pickMathsQuestion(rng, { questionType: 'counting', difficulty: 'hard' }));
    for (let i = 0; i < 120; i++) qs.push(S.pickMathsQuestion(rng, { questionType: 'counting', difficulty: 'easy' }));
    return qs;
  };

  test('exactly four distinct options, the answer present once', () => {
    const rng = seeded(29);
    for (const q of everyQuestion()) {
      const opts = S.mathsOptions(q, rng);
      assert.equal(opts.length, 4, `${q.prompt}: ${opts.join()}`);
      assert.equal(new Set(opts).size, 4, `${q.prompt}: duplicate option in ${opts.join()}`);
      assert.equal(opts.filter(v => v === q.answer).length, 1, `${q.prompt}: answer appears ${opts.filter(v => v === q.answer).length}x`);
    }
  });

  test('every option is a plausible number', () => {
    const rng = seeded(31);
    for (const q of everyQuestion()) {
      const cap = q.segments.length === 1 ? 60 : 180;
      for (const v of S.mathsOptions(q, rng)) {
        assert.ok(Number.isInteger(v) && v >= 1 && v <= cap, `${q.prompt}: implausible option ${v}`);
      }
    }
  });

  test('no option is eliminable on magnitude alone', () => {
    // If one option is wildly far from the rest, it can be discarded without
    // knowing anything, which turns a 1-in-4 into a 1-in-3.
    const rng = seeded(37);
    for (const q of everyQuestion()) {
      const spread = Math.max(20, Math.round(q.answer * 0.25));
      for (const v of S.mathsOptions(q, rng)) {
        assert.ok(Math.abs(v - q.answer) <= spread,
          `${q.prompt} (=${q.answer}): ${v} is ${Math.abs(v - q.answer)} away, spread is ${spread}`);
      }
    }
  });

  test('NO ARITHMETIC SHORTCUT — a treble question offers only multiples of 3', () => {
    const rng = seeded(41);
    for (const seg of HARD.filter(s => /^T/.test(s))) {
      const q = S.mathsQuestionFromPrompt(seg, 'segment');
      for (const v of S.mathsOptions(q, rng)) {
        assert.equal(v % 3, 0, `${seg}: ${v} is not a multiple of 3 — divisibility identifies the answer`);
      }
    }
  });

  test('NO ARITHMETIC SHORTCUT — a double question offers only even numbers', () => {
    // The leak the mockups actually shipped with: D17 -> 34 · 36 · 28 · 51.
    const rng = seeded(43);
    for (const seg of HARD.filter(s => /^D/.test(s) || s === 'Bull')) {
      const q = S.mathsQuestionFromPrompt(seg, 'segment');
      for (const v of S.mathsOptions(q, rng)) {
        assert.equal(v % 2, 0, `${seg}: ${v} is odd — parity identifies the answer`);
      }
    }
  });

  test("NO ARITHMETIC SHORTCUT — a visit's options all match the total's parity", () => {
    // Derivable without knowing any dart's value: a double is even, and whether
    // 17 and 13 are odd is free. So an odd option against an even total is a
    // free elimination. The mockups shipped with this one too.
    const rng = seeded(47);
    for (let i = 0; i < 400; i++) {
      const q = S.pickMathsQuestion(rng, { questionType: 'counting', difficulty: i % 2 ? 'hard' : 'easy' });
      for (const v of S.mathsOptions(q, rng)) {
        assert.equal(v % 2, q.answer % 2,
          `${q.prompt} (=${q.answer}): ${v} has the wrong parity`);
      }
    }
  });

  test('NO POSITIONAL BIAS — the answer lands in each slot about equally often', () => {
    const rng = seeded(53);
    const at = [0, 0, 0, 0];
    const N = 8000;
    for (let i = 0; i < N; i++) {
      const q = S.mathsQuestionFromPrompt(EASY[i % EASY.length], 'segment');
      at[S.mathsOptions(q, rng).indexOf(q.answer)]++;
    }
    const expected = N / 4;
    for (let i = 0; i < 4; i++) {
      const drift = Math.abs(at[i] - expected) / expected;
      assert.ok(drift < 0.12, `slot ${i} held the answer ${at[i]}/${N} times (${(drift*100).toFixed(1)}% off uniform)`);
    }
  });

  test('the same question does not always offer the same three wrong answers', () => {
    const rng = seeded(59);
    const q = S.mathsQuestionFromPrompt('T19', 'segment');
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(S.mathsDistractors(q, rng).slice().sort((a,b)=>a-b).join());
    assert.ok(seen.size > 1, 'distractors are fixed for a given segment — the set becomes memorable');
  });
});

describe('the instant threshold', () => {
  const q = S.mathsQuestionFromPrompt('T19', 'segment');

  test('correct and fast is "known"', () => {
    const g = S.gradeMathsAnswer(q, 57, 900);
    assert.equal(g.correct, true); assert.equal(g.instant, true); assert.equal(g.verdict, 'known');
  });

  test('correct and slow is "worked" — NOT known', () => {
    // The distinction the whole mode rests on. A mode that called this "known"
    // would certify a skill the player has not got.
    const g = S.gradeMathsAnswer(q, 57, 2200);
    assert.equal(g.correct, true, 'still a correct answer');
    assert.equal(g.instant, false);
    assert.equal(g.verdict, 'worked');
  });

  test('exactly on the threshold counts as known', () => {
    assert.equal(S.gradeMathsAnswer(q, 57, S.mathsInstantMs('segment')).verdict, 'known');
    assert.equal(S.gradeMathsAnswer(q, 57, S.mathsInstantMs('segment') + 1).verdict, 'worked');
  });

  test('wrong is wrong however fast', () => {
    const g = S.gradeMathsAnswer(q, 54, 300);
    assert.equal(g.correct, false); assert.equal(g.instant, false); assert.equal(g.verdict, 'wrong');
  });

  test('never answered is a timeout — neither correct nor a streak', () => {
    const g = S.gradeMathsAnswer(q, null, null);
    assert.equal(g.answered, false); assert.equal(g.correct, false); assert.equal(g.verdict, 'timeout');
  });

  test('counting gets a longer window than a single segment', () => {
    assert.ok(S.mathsInstantMs('counting') > S.mathsInstantMs('segment'),
      'totalling three darts cannot be held to a single-segment recall time');
  });

  test('the working is shown, and is arithmetically true', () => {
    assert.equal(S.gradeMathsAnswer(q, 54, 900).working, 'T19 = 19 × 3 = 57');
    const c = S.mathsQuestionFromPrompt('T17,13,D19', 'counting');
    assert.equal(S.mathsWorking(c), 'T17 = 51, 13 = 13, D19 = 38 → 102');
    assert.equal(c.answer, 102);
  });
});

describe('segments known cold', () => {
  const rowsFor = (per) => {
    const out = [];
    for (const [seg, list] of Object.entries(per)) {
      for (const [correct, ms] of list) out.push({ prompt: seg, correct, answered_ms: ms, question_type: 'segment' });
    }
    return out;
  };
  const W = S.MATHS_KNOWN_WINDOW;
  const fast = 700, slow = 2400;

  test('three recent fast correct answers make a segment known', () => {
    const r = S.mathsSegmentsKnown(rowsFor({ T19: Array(W).fill([1, fast]) }), { difficulty: 'easy' });
    assert.equal(r.knownCount, 1);
    assert.equal(r.segments.find(s => s.segment === 'T19').state, 'known');
  });

  test('correct but slow is "slow", never known', () => {
    const r = S.mathsSegmentsKnown(rowsFor({ T19: Array(W).fill([1, slow]) }), { difficulty: 'easy' });
    assert.equal(r.knownCount, 0);
    assert.equal(r.segments.find(s => s.segment === 'T19').state, 'slow');
  });

  test('one slow answer entering the window demotes a known segment', () => {
    // Learning is not a ratchet. A segment you have started stalling on again is
    // not one you know, and the window is what makes that self-correcting.
    const rows = rowsFor({ T19: Array(W).fill([1, fast]) });
    rows.push({ prompt: 'T19', correct: 1, answered_ms: slow, question_type: 'segment' });
    assert.equal(S.mathsSegmentsKnown(rows, { difficulty: 'easy' }).knownCount, 0);
  });

  test('fewer attempts than the window is never known, however fast', () => {
    const r = S.mathsSegmentsKnown(rowsFor({ T19: Array(W - 1).fill([1, 200]) }), { difficulty: 'easy' });
    assert.equal(r.knownCount, 0, 'one lucky fast tap is not knowledge');
  });

  test('an untouched segment is cold, and the pool is fully reported', () => {
    const r = S.mathsSegmentsKnown([], { difficulty: 'easy' });
    assert.equal(r.poolSize, EASY.length);
    assert.equal(r.segments.length, EASY.length);
    assert.ok(r.segments.every(s => s.state === 'cold' && s.attempts === 0));
    assert.equal(r.knownCount, 0);
  });

  test('every reported segment carries its value, for the crib sheet', () => {
    const r = S.mathsSegmentsKnown([], { difficulty: 'hard' });
    for (const s of r.segments) assert.equal(s.value, S.mathsSegmentValue(s.segment), s.segment);
  });

  test('the verdict is derived at read time, not stored', () => {
    // Storing an `instant` boolean would freeze a tunable constant into history:
    // retuning the threshold has to reclassify the past, not disagree with it.
    const rows = rowsFor({ T19: Array(W).fill([1, S.mathsInstantMs('segment') - 1]) });
    assert.equal(S.mathsSegmentsKnown(rows, { difficulty: 'easy' }).knownCount, 1);
    const justOver = rowsFor({ T19: Array(W).fill([1, S.mathsInstantMs('segment') + 1]) });
    assert.equal(S.mathsSegmentsKnown(justOver, { difficulty: 'easy' }).knownCount, 0);
  });
});

describe('best instant streak', () => {
  const row = (correct, ms, qt) => ({ correct, answered_ms: ms, question_type: qt || 'segment' });

  test('counts consecutive known answers and resets on anything else', () => {
    assert.equal(S.mathsBestInstantStreak([row(1,500), row(1,500), row(1,500)]), 3);
    assert.equal(S.mathsBestInstantStreak([row(1,500), row(0,500), row(1,500)]), 1);
    assert.equal(S.mathsBestInstantStreak([row(1,500), row(1,9000), row(1,500), row(1,500)]), 2,
      'a correct-but-slow answer breaks the run — the run is about recall, not correctness');
    assert.equal(S.mathsBestInstantStreak([]), 0);
  });

  test('a timeout breaks the run', () => {
    assert.equal(S.mathsBestInstantStreak([row(1,500), row(0,null), row(1,500)]), 1);
  });

  test('each row is judged against its own question type', () => {
    // 2s is slow for a segment and fast for a 3-dart total.
    assert.equal(S.mathsBestInstantStreak([row(1, 2000, 'segment')]), 0);
    assert.equal(S.mathsBestInstantStreak([row(1, 2000, 'counting')]), 1);
  });
});
