export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(message: string, code = "BAD_REQUEST"): HttpError {
  return new HttpError(400, code, message);
}

export function notFound(message: string, code = "NOT_FOUND"): HttpError {
  return new HttpError(404, code, message);
}

export function conflict(message: string, code = "CONFLICT"): HttpError {
  return new HttpError(409, code, message);
}

export function upstreamError(message: string, code = "UPSTREAM_ERROR"): HttpError {
  return new HttpError(502, code, message);
}
