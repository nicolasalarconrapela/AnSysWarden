import { getLanguage } from '../../../i18n';

export const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  magenta: '\u001b[35m',
  gray: '\u001b[90m',
} as const;

export function paint(text: string, code: string): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `${code}${text}${ANSI.reset}`;
}

export function pick(en: string, es: string): string {
  return getLanguage() === 'es' ? es : en;
}

export function divider(character = '─', width = 40): string {
  return character.repeat(width);
}

export function title(text: string, width = 40): void {
  console.log(`\n${text}`);
  console.log(divider('─', width));
}

export function section(text: string, width = 40): void {
  console.log(`\n${text}`);
  console.log(divider('─', width));
}
