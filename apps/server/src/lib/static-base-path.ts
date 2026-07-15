const STATIC_BASE_PATH = /^\/(?:[A-Za-z0-9][A-Za-z0-9_-]*)(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

export const STATIC_BASE_PATH_MAX_LENGTH = 200;
export const STATIC_BASE_PATH_ERROR = "Hosting-Basispfad muss '/' oder ein Pfad wie '/foo/bar' sein (nur Buchstaben, Ziffern, '-' und '_')";

export function isValidStaticBasePath(value: unknown): value is string | null {
  return value === null || (
    typeof value === "string"
    && value.length <= STATIC_BASE_PATH_MAX_LENGTH
    && (value === "/" || STATIC_BASE_PATH.test(value))
  );
}

export function assertValidStaticBasePath(value: unknown): asserts value is string | null {
  if (!isValidStaticBasePath(value)) throw new Error(STATIC_BASE_PATH_ERROR);
}
