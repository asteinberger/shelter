import type { Credentials } from "./config.js";

export interface ApiErrorPayload {
  error?: unknown;
  code?: unknown;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;

  constructor(status: number, payload: ApiErrorPayload | null, secret = "") {
    const unsafeMessage = typeof payload?.error === "string" && payload.error.trim()
      ? payload.error
      : `Shelter API request failed with status ${status}.`;
    const message = secret ? unsafeMessage.split(secret).join("[REDACTED]") : unsafeMessage;
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = typeof payload?.code === "string" ? payload.code : null;
    this.details = payload?.details;
  }
}

export type FetchImplementation = typeof fetch;

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
}

export class ShelterClient {
  readonly serverUrl: string;
  readonly #token: string;
  readonly #fetch: FetchImplementation;

  constructor(credentials: Credentials, fetchImplementation: FetchImplementation = fetch) {
    this.serverUrl = credentials.serverUrl;
    this.#token = credentials.token;
    this.#fetch = fetchImplementation;
  }

  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${this.#token}`);
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      if (
        options.body instanceof ArrayBuffer ||
        ArrayBuffer.isView(options.body) ||
        options.body instanceof Blob ||
        typeof options.body === "string"
      ) {
        body = options.body as BodyInit;
      } else {
        headers.set("content-type", "application/json");
        body = JSON.stringify(options.body);
      }
    }

    let response: Response;
    try {
      response = await this.#fetch(new URL(path, `${this.serverUrl}/`), {
        method: options.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body })
      });
    } catch (error) {
      const unsafeReason = error instanceof Error ? error.message : "Network error";
      const reason = unsafeReason.split(this.#token).join("[REDACTED]");
      throw new Error(`Could not reach the Shelter server: ${reason}`);
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => null) as ApiErrorPayload | null;
      throw new ApiError(response.status, payload, this.#token);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}
