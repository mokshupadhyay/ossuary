/**
 * Blanks comments while keeping every other character, the total length and
 * every newline in place (design D5). String and template contents are kept,
 * because SQL lives in them. Regex literals are not recognised, so a `//`
 * inside a regex is treated as a comment; that only hides text from the
 * checker, never invents it.
 */
export type SourceLanguage = 'ts' | 'sql';

export function stripComments(src: string, lang: SourceLanguage = 'ts'): string {
  return lang === 'sql' ? stripSql(src) : stripTs(src);
}

const blank = (ch: string): string => (ch === '\n' || ch === '\r' ? ch : ' ');

function stripTs(src: string): string {
  type Mode = 'code' | 'line' | 'block' | "'" | '"' | '`';
  let mode: Mode = 'code';
  // One entry per open `${`: the brace depth inside that substitution.
  const templateDepth: number[] = [];
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    const next = src[i + 1];
    switch (mode) {
      case 'code':
        if (ch === '/' && next === '/') {
          mode = 'line';
          out += '  ';
          i++;
        } else if (ch === '/' && next === '*') {
          mode = 'block';
          out += '  ';
          i++;
        } else {
          if (ch === "'" || ch === '"' || ch === '`') mode = ch;
          else if (templateDepth.length > 0 && ch === '{') templateDepth[templateDepth.length - 1]!++;
          else if (templateDepth.length > 0 && ch === '}') {
            if (templateDepth[templateDepth.length - 1] === 0) {
              templateDepth.pop();
              mode = '`';
            } else templateDepth[templateDepth.length - 1]!--;
          }
          out += ch;
        }
        break;
      case 'line':
        if (ch === '\n') {
          mode = 'code';
          out += ch;
        } else out += blank(ch);
        break;
      case 'block':
        if (ch === '*' && next === '/') {
          mode = 'code';
          out += '  ';
          i++;
        } else out += blank(ch);
        break;
      case "'":
      case '"':
        out += ch;
        if (ch === '\\' && next !== undefined) {
          out += next;
          i++;
        } else if (ch === mode || ch === '\n') mode = 'code';
        break;
      case '`':
        out += ch;
        if (ch === '\\' && next !== undefined) {
          out += next;
          i++;
        } else if (ch === '`') mode = 'code';
        else if (ch === '$' && next === '{') {
          out += next;
          i++;
          templateDepth.push(0);
          mode = 'code';
        }
        break;
    }
  }
  return out;
}

function stripSql(src: string): string {
  type Mode = 'code' | 'line' | 'block' | "'" | '"';
  let mode: Mode = 'code';
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    const next = src[i + 1];
    switch (mode) {
      case 'code':
        if (ch === '-' && next === '-') {
          mode = 'line';
          out += '  ';
          i++;
        } else if (ch === '/' && next === '*') {
          mode = 'block';
          out += '  ';
          i++;
        } else {
          if (ch === "'" || ch === '"') mode = ch;
          out += ch;
        }
        break;
      case 'line':
        if (ch === '\n') {
          mode = 'code';
          out += ch;
        } else out += blank(ch);
        break;
      case 'block':
        if (ch === '*' && next === '/') {
          mode = 'code';
          out += '  ';
          i++;
        } else out += blank(ch);
        break;
      case "'":
      case '"':
        out += ch;
        if (ch === mode) mode = 'code'; // '' inside a string closes and reopens: same result
        break;
    }
  }
  return out;
}
