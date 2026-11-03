/**
 * Double Metaphone (Lawrence Philips, 2000), own implementation of the published algorithm.
 * Input: one Latin token (any case; non A-Z letters are dropped). Output: [primary, alternate], each at most 4 chars.
 */

const VOWEL = new Set(['A', 'E', 'I', 'O', 'U', 'Y']);

export function doubleMetaphone(input: string): [string, string] {
  const word = input.toUpperCase().replace(/[^A-Z]/g, '');
  if (word === '') return ['', ''];
  const length = word.length;
  const last = length - 1;
  const value = word + '     ';
  const slavoGermanic = /W|K|CZ|WITZ/.test(word);
  const germanic = /^(VAN |VON |SCH)/.test(value);
  let primary = '';
  let secondary = '';
  let current = 0;

  const at = (i: number): string => (i < 0 || i >= value.length ? '' : (value[i] ?? ''));
  const isVowel = (i: number): boolean => VOWEL.has(at(i));
  const stringAt = (start: number, len: number, ...options: string[]): boolean => {
    if (start < 0) return false;
    const sub = value.slice(start, start + len);
    return options.includes(sub);
  };
  const add = (main: string, alt: string = main): void => {
    primary += main;
    secondary += alt;
  };

  if (stringAt(0, 2, 'GN', 'KN', 'PN', 'WR', 'PS')) current += 1;
  if (at(0) === 'X') {
    add('S');
    current += 1;
  }

  while (current < length && (primary.length < 4 || secondary.length < 4)) {
    const ch = at(current);
    switch (ch) {
      case 'A':
      case 'E':
      case 'I':
      case 'O':
      case 'U':
      case 'Y':
        if (current === 0) add('A');
        current += 1;
        break;
      case 'B':
        add('P');
        current += at(current + 1) === 'B' ? 2 : 1;
        break;
      case 'C':
        if (
          current > 1 &&
          !isVowel(current - 2) &&
          stringAt(current - 1, 3, 'ACH') &&
          at(current + 2) !== 'I' &&
          (at(current + 2) !== 'E' || stringAt(current - 2, 6, 'BACHER', 'MACHER'))
        ) {
          add('K');
          current += 2;
          break;
        }
        if (current === 0 && stringAt(current, 6, 'CAESAR')) {
          add('S');
          current += 2;
          break;
        }
        if (stringAt(current, 4, 'CHIA')) {
          add('K');
          current += 2;
          break;
        }
        if (stringAt(current, 2, 'CH')) {
          if (current > 0 && stringAt(current, 4, 'CHAE')) {
            add('K', 'X');
            current += 2;
            break;
          }
          if (
            current === 0 &&
            (stringAt(current + 1, 5, 'HARAC', 'HARIS') || stringAt(current + 1, 3, 'HOR', 'HYM', 'HIA', 'HEM')) &&
            !stringAt(0, 5, 'CHORE')
          ) {
            add('K');
            current += 2;
            break;
          }
          if (
            germanic ||
            stringAt(current - 2, 6, 'ORCHES', 'ARCHIT', 'ORCHID') ||
            stringAt(current + 2, 1, 'T', 'S') ||
            ((stringAt(current - 1, 1, 'A', 'O', 'U', 'E') || current === 0) &&
              stringAt(current + 2, 1, 'L', 'R', 'N', 'M', 'B', 'H', 'F', 'V', 'W', ' '))
          ) {
            add('K');
          } else if (current > 0) {
            if (stringAt(0, 2, 'MC')) add('K');
            else add('X', 'K');
          } else {
            add('X');
          }
          current += 2;
          break;
        }
        if (stringAt(current, 2, 'CZ') && !stringAt(current - 2, 4, 'WICZ')) {
          add('S', 'X');
          current += 2;
          break;
        }
        if (stringAt(current + 1, 3, 'CIA')) {
          add('X');
          current += 3;
          break;
        }
        if (stringAt(current, 2, 'CC') && !(current === 1 && at(0) === 'M')) {
          if (stringAt(current + 2, 1, 'I', 'E', 'H') && !stringAt(current + 2, 2, 'HU')) {
            if ((current === 1 && at(current - 1) === 'A') || stringAt(current - 1, 5, 'UCCEE', 'UCCES')) add('KS');
            else add('X');
            current += 3;
            break;
          }
          add('K');
          current += 2;
          break;
        }
        if (stringAt(current, 2, 'CK', 'CG', 'CQ')) {
          add('K');
          current += 2;
          break;
        }
        if (stringAt(current, 2, 'CI', 'CE', 'CY')) {
          if (stringAt(current, 3, 'CIO', 'CIE', 'CIA')) add('S', 'X');
          else add('S');
          current += 2;
          break;
        }
        add('K');
        if (stringAt(current + 1, 2, ' C', ' Q', ' G')) current += 3;
        else if (stringAt(current + 1, 1, 'C', 'K', 'Q') && !stringAt(current + 1, 2, 'CE', 'CI')) current += 2;
        else current += 1;
        break;
      case 'D':
        if (stringAt(current, 2, 'DG')) {
          if (stringAt(current + 2, 1, 'I', 'E', 'Y')) {
            add('J');
            current += 3;
          } else {
            add('TK');
            current += 2;
          }
          break;
        }
        if (stringAt(current, 2, 'DT', 'DD')) {
          add('T');
          current += 2;
          break;
        }
        add('T');
        current += 1;
        break;
      case 'F':
        current += at(current + 1) === 'F' ? 2 : 1;
        add('F');
        break;
      case 'G':
        if (at(current + 1) === 'H') {
          if (current > 0 && !isVowel(current - 1)) {
            add('K');
            current += 2;
            break;
          }
          if (current === 0) {
            if (at(current + 2) === 'I') add('J');
            else add('K');
            current += 2;
            break;
          }
          if (
            (current > 1 && stringAt(current - 2, 1, 'B', 'H', 'D')) ||
            (current > 2 && stringAt(current - 3, 1, 'B', 'H', 'D')) ||
            (current > 3 && stringAt(current - 4, 1, 'B', 'H'))
          ) {
            current += 2;
            break;
          }
          if (current > 2 && at(current - 1) === 'U' && stringAt(current - 3, 1, 'C', 'G', 'L', 'R', 'T')) add('F');
          else if (current > 0 && at(current - 1) !== 'I') add('K');
          current += 2;
          break;
        }
        if (at(current + 1) === 'N') {
          if (current === 1 && isVowel(0) && !slavoGermanic) add('KN', 'N');
          else if (!stringAt(current + 2, 2, 'EY') && at(current + 1) !== 'Y' && !slavoGermanic) add('N', 'KN');
          else add('KN');
          current += 2;
          break;
        }
        if (stringAt(current + 1, 2, 'LI') && !slavoGermanic) {
          add('KL', 'L');
          current += 2;
          break;
        }
        if (
          current === 0 &&
          (at(current + 1) === 'Y' ||
            stringAt(current + 1, 2, 'ES', 'EP', 'EB', 'EL', 'EY', 'IB', 'IL', 'IN', 'IE', 'EI', 'ER'))
        ) {
          add('K', 'J');
          current += 2;
          break;
        }
        if (
          (stringAt(current + 1, 2, 'ER') || at(current + 1) === 'Y') &&
          !stringAt(0, 6, 'DANGER', 'RANGER', 'MANGER') &&
          !stringAt(current - 1, 1, 'E', 'I') &&
          !stringAt(current - 1, 3, 'RGY', 'OGY')
        ) {
          add('K', 'J');
          current += 2;
          break;
        }
        if (stringAt(current + 1, 1, 'E', 'I', 'Y') || stringAt(current - 1, 4, 'AGGI', 'OGGI')) {
          if (germanic || stringAt(current + 1, 2, 'ET')) add('K');
          else if (stringAt(current + 1, 4, 'IER ')) add('J');
          else add('J', 'K');
          current += 2;
          break;
        }
        current += at(current + 1) === 'G' ? 2 : 1;
        add('K');
        break;
      case 'H':
        if ((current === 0 || isVowel(current - 1)) && isVowel(current + 1)) {
          add('H');
          current += 2;
        } else {
          current += 1;
        }
        break;
      case 'J':
        if (stringAt(current, 4, 'JOSE') || stringAt(0, 4, 'SAN ')) {
          if ((current === 0 && at(current + 4) === ' ') || stringAt(0, 4, 'SAN ')) add('H');
          else add('J', 'H');
          current += 1;
          break;
        }
        if (current === 0) add('J', 'A');
        else if (isVowel(current - 1) && !slavoGermanic && (at(current + 1) === 'A' || at(current + 1) === 'O'))
          add('J', 'H');
        else if (current === last) add('J', '');
        else if (
          !stringAt(current + 1, 1, 'L', 'T', 'K', 'S', 'N', 'M', 'B', 'Z') &&
          !stringAt(current - 1, 1, 'S', 'K', 'L')
        )
          add('J');
        current += at(current + 1) === 'J' ? 2 : 1;
        break;
      case 'K':
        current += at(current + 1) === 'K' ? 2 : 1;
        add('K');
        break;
      case 'L':
        if (at(current + 1) === 'L') {
          if (
            (current === length - 3 && stringAt(current - 1, 4, 'ILLO', 'ILLA', 'ALLE')) ||
            ((stringAt(last - 1, 2, 'AS', 'OS') || stringAt(last, 1, 'A', 'O')) && stringAt(current - 1, 4, 'ALLE'))
          ) {
            add('L', '');
            current += 2;
            break;
          }
          current += 2;
        } else {
          current += 1;
        }
        add('L');
        break;
      case 'M':
        if (
          (stringAt(current - 1, 3, 'UMB') && (current + 1 === last || stringAt(current + 2, 2, 'ER'))) ||
          at(current + 1) === 'M'
        )
          current += 2;
        else current += 1;
        add('M');
        break;
      case 'N':
        current += at(current + 1) === 'N' ? 2 : 1;
        add('N');
        break;
      case 'P':
        if (at(current + 1) === 'H') {
          add('F');
          current += 2;
          break;
        }
        current += stringAt(current + 1, 1, 'P', 'B') ? 2 : 1;
        add('P');
        break;
      case 'Q':
        current += at(current + 1) === 'Q' ? 2 : 1;
        add('K');
        break;
      case 'R':
        if (
          current === last &&
          !slavoGermanic &&
          stringAt(current - 2, 2, 'IE') &&
          !stringAt(current - 4, 2, 'ME', 'MA')
        )
          add('', 'R');
        else add('R');
        current += at(current + 1) === 'R' ? 2 : 1;
        break;
      case 'S':
        if (stringAt(current - 1, 3, 'ISL', 'YSL')) {
          current += 1;
          break;
        }
        if (current === 0 && stringAt(current, 5, 'SUGAR')) {
          add('X', 'S');
          current += 1;
          break;
        }
        if (stringAt(current, 2, 'SH')) {
          if (stringAt(current + 1, 4, 'HEIM', 'HOEK', 'HOLM', 'HOLZ')) add('S');
          else add('X');
          current += 2;
          break;
        }
        if (stringAt(current, 3, 'SIO', 'SIA') || stringAt(current, 4, 'SIAN')) {
          if (!slavoGermanic) add('S', 'X');
          else add('S');
          current += 3;
          break;
        }
        if ((current === 0 && stringAt(current + 1, 1, 'M', 'N', 'L', 'W')) || stringAt(current + 1, 1, 'Z')) {
          add('S', 'X');
          current += stringAt(current + 1, 1, 'Z') ? 2 : 1;
          break;
        }
        if (stringAt(current, 2, 'SC')) {
          if (at(current + 2) === 'H') {
            if (stringAt(current + 3, 2, 'OO', 'ER', 'EN', 'UY', 'ED', 'EM')) {
              if (stringAt(current + 3, 2, 'ER', 'EN')) add('X', 'SK');
              else add('SK');
              current += 3;
              break;
            }
            if (current === 0 && !isVowel(3) && at(3) !== 'W') add('X', 'S');
            else add('X');
            current += 3;
            break;
          }
          if (stringAt(current + 2, 1, 'I', 'E', 'Y')) {
            add('S');
            current += 3;
            break;
          }
          add('SK');
          current += 3;
          break;
        }
        if (current === last && stringAt(current - 2, 2, 'AI', 'OI')) add('', 'S');
        else add('S');
        current += stringAt(current + 1, 1, 'S', 'Z') ? 2 : 1;
        break;
      case 'T':
        if (stringAt(current, 4, 'TION')) {
          add('X');
          current += 3;
          break;
        }
        if (stringAt(current, 3, 'TIA', 'TCH')) {
          add('X');
          current += 3;
          break;
        }
        if (stringAt(current, 2, 'TH') || stringAt(current, 3, 'TTH')) {
          if (stringAt(current + 2, 2, 'OM', 'AM') || germanic) add('T');
          else add('0', 'T');
          current += 2;
          break;
        }
        current += stringAt(current + 1, 1, 'T', 'D') ? 2 : 1;
        add('T');
        break;
      case 'V':
        current += at(current + 1) === 'V' ? 2 : 1;
        add('F');
        break;
      case 'W':
        if (stringAt(current, 2, 'WR')) {
          add('R');
          current += 2;
          break;
        }
        if (current === 0 && (isVowel(current + 1) || stringAt(current, 2, 'WH'))) {
          if (isVowel(current + 1)) add('A', 'F');
          else add('A');
        }
        if (
          (current === last && isVowel(current - 1)) ||
          stringAt(current - 1, 5, 'EWSKI', 'EWSKY', 'OWSKI', 'OWSKY') ||
          stringAt(0, 3, 'SCH')
        ) {
          add('', 'F');
          current += 1;
          break;
        }
        if (stringAt(current, 4, 'WICZ', 'WITZ')) {
          add('TS', 'FX');
          current += 4;
          break;
        }
        current += 1;
        break;
      case 'X':
        if (!(current === last && (stringAt(current - 3, 3, 'IAU', 'EAU') || stringAt(current - 2, 2, 'AU', 'OU'))))
          add('KS');
        current += stringAt(current + 1, 1, 'C', 'X') ? 2 : 1;
        break;
      case 'Z':
        if (at(current + 1) === 'H') {
          add('J');
          current += 2;
          break;
        }
        if (stringAt(current + 1, 2, 'ZO', 'ZI', 'ZA') || (slavoGermanic && current > 0 && at(current - 1) !== 'T'))
          add('S', 'TS');
        else add('S');
        current += at(current + 1) === 'Z' ? 2 : 1;
        break;
      default:
        current += 1;
    }
  }

  return [primary.slice(0, 4), secondary.slice(0, 4)];
}
