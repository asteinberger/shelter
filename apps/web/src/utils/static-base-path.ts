import { localize } from '../i18n';

export const MAX_STATIC_BASE_PATH_LENGTH = 200;

const staticBasePathPattern = /^\/(?:[A-Za-z0-9][A-Za-z0-9_-]*)(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

/**
 * Keeps editing predictable: a missing leading slash is added immediately,
 * while the harmless trailing slash is only removed when editing finishes.
 */
export function normalizeStaticBasePath(value: string, finalize = false) {
  let normalized = value;
  if (normalized && !normalized.startsWith('/') && !normalized.startsWith('\\')) {
    normalized = `/${normalized}`;
  }
  if (finalize && normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  return normalized;
}

export function staticBasePathError(value: string) {
  if (!value) return localize('Enter / for the apex domain or a path such as /shop.', 'Gib / für die Hauptdomain oder einen Pfad wie /shop ein.');
  if (value.length > MAX_STATIC_BASE_PATH_LENGTH) {
    return localize(
      'The hosting path may contain at most {count} characters.',
      'Der Hosting-Pfad darf höchstens {count} Zeichen lang sein.',
      { count: MAX_STATIC_BASE_PATH_LENGTH },
    );
  }
  if (value === '/') return undefined;
  if (value.includes('\\')) return localize('Use forward slashes (/), not backslashes.', 'Verwende normale Schrägstriche (/), keine Backslashes.');
  if (/[?#]/.test(value)) return localize('Query parameters and fragments do not belong in the hosting path.', 'Query-Parameter und Anker gehören nicht in den Hosting-Pfad.');
  if (/\s/.test(value)) return localize('The hosting path cannot contain spaces.', 'Der Hosting-Pfad darf keine Leerzeichen enthalten.');
  if (value.endsWith('/')) return localize('The trailing slash is removed when you leave the field.', 'Der abschließende Schrägstrich wird beim Verlassen des Feldes entfernt.');
  if (!staticBasePathPattern.test(value)) {
    return localize(
      'Every segment must begin with a letter or number; _ and - are also allowed.',
      'Jeder Abschnitt muss mit einer Zahl oder einem Buchstaben beginnen; erlaubt sind außerdem _ und -.',
    );
  }
  return undefined;
}
