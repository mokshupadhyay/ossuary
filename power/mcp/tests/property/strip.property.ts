// Feature: ossuary-power, Property 3: Comment stripping preserves length and line structure
// Validates: Requirement 2.7
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { stripComments, type SourceLanguage } from '../../src/strip.js';

/*
 * Mutation checks, each confirmed to fail this property before it was accepted:
 *   - delete comment characters instead of blanking them (line and block modes)
 *     → fails all four tests, e.g. counterexamples: a block comment holding "a", and "///".
 *   - blank newlines inside block comments too (`out += ' '` in block mode)
 *     → fails, counterexample: a block comment holding only a newline.
 *   - ignore backslash escapes in '...' and "..." strings
 *     → fails, counterexample {"text":"'\\''//\n"}: the comment after the string is kept.
 */

interface Piece {
  text: string;
  expected: string;
}

const blankAll = (s: string) => s.replace(/[^\n]/g, ' ');
const textOf = (chars: string, maxLength = 12) =>
  fc.string({ unit: fc.constantFrom(...chars.split('')), maxLength });

const tsPieces: fc.Arbitrary<Piece>[] = [
  // Plain code: no comment openers, quotes, braces or backslashes.
  textOf('abc =;:()1\n ').map((t) => ({ text: t, expected: t })),
  textOf('abc /*\'"` x').map((t) => ({ text: `//${t}\n`, expected: `${blankAll(`//${t}`)}\n` })),
  textOf('abc /\'"`\n x*').filter((t) => !t.includes('*/') && !t.endsWith('*')).map((t) => ({
    text: `/*${t}*/`,
    expected: blankAll(`/*${t}*/`),
  })),
  textOf('abc /*"` x').map((t) => ({ text: `'${t}'`, expected: `'${t}'` })),
  textOf("abc /*' x").map((t) => ({ text: `"${t}"`, expected: `"${t}"` })),
  textOf('abc /*\'"\n x').map((t) => ({ text: `\`${t}\``, expected: `\`${t}\`` })),
  fc.constantFrom("'\\''", '"\\""', '`\\``', '`${a}`', '`${ {a:1}.a }//x`').map((t) => ({ text: t, expected: t })),
];

const sqlPieces: fc.Arbitrary<Piece>[] = [
  textOf('abc =;:()1\n ').map((t) => ({ text: t, expected: t })),
  textOf("abc /*-' x").map((t) => ({ text: `--${t}\n`, expected: `${blankAll(`--${t}`)}\n` })),
  textOf("abc -'\n x*").filter((t) => !t.includes('*/') && !t.endsWith('*')).map((t) => ({
    text: `/*${t}*/`,
    expected: blankAll(`/*${t}*/`),
  })),
  textOf('abc --/* x').map((t) => ({ text: `'${t}'`, expected: `'${t}'` })),
];

const programArb = (pieces: fc.Arbitrary<Piece>[]) =>
  fc.array(fc.oneof(...pieces), { maxLength: 25 }).map((ps) => ({
    text: ps.map((p) => p.text).join(''),
    expected: ps.map((p) => p.expected).join(''),
  }));

const newlineIndexes = (s: string) => [...s].flatMap((c, i) => (c === '\n' ? [i] : []));

describe('Property 3: comment stripping preserves length and line structure', () => {
  for (const [lang, pieces] of [['ts', tsPieces], ['sql', sqlPieces]] as [SourceLanguage, fc.Arbitrary<Piece>[]][]) {
    it(`${lang}: blanks exactly the comments of a tokenised program`, () => {
      fc.assert(
        fc.property(programArb(pieces), ({ text, expected }) => {
          expect(stripComments(text, lang)).toBe(expected);
        }),
        { numRuns: 300 },
      );
    });

    it(`${lang}: keeps the length and every newline of any string`, () => {
      fc.assert(
        fc.property(fc.string({ unit: fc.constantFrom('/', '*', '-', "'", '"', '`', '\\', '$', '{', '}', '\n', 'a', ' '), maxLength: 80 }), (s) => {
          const out = stripComments(s, lang);
          expect(out.length).toBe(s.length);
          expect(newlineIndexes(out)).toEqual(newlineIndexes(s));
        }),
        { numRuns: 300 },
      );
    });
  }
});
