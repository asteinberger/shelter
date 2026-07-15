import { describe, expect, it, vi } from "vitest";
import { ApiError, type FetchImplementation, ShelterClient } from "../src/api.js";

const validToken = `shelter_pat_v1_${"A".repeat(43)}`;

describe("ShelterClient", () => {
  it("sends bearer authentication and JSON bodies", async () => {
    const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ input: String(input), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as FetchImplementation;
    const client = new ShelterClient({ serverUrl: "https://hosting.example", token: validToken }, request);

    await expect(client.request("/api/projects", { method: "POST", body: { name: "Demo" } })).resolves.toEqual({ ok: true });
    expect(requests[0]?.input).toBe("https://hosting.example/api/projects");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${validToken}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ name: "Demo" }));
  });

  it("never exposes the token in API or network error messages", async () => {
    const token = `shelter_pat_v1_${"B".repeat(43)}`;
    const apiFailure = (async () => new Response(JSON.stringify({
      error: `Rejected ${token}`,
      code: "UNAUTHORIZED"
    }), { status: 401, headers: { "content-type": "application/json" } })) as FetchImplementation;
    const apiClient = new ShelterClient({ serverUrl: "https://hosting.example", token }, apiFailure);

    const error = await apiClient.request("/api/projects").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(String(error)).not.toContain(token);
    expect(String(error)).toContain("[REDACTED]");

    const networkFailure = (async () => { throw new Error(`socket failed for ${token}`); }) as FetchImplementation;
    const networkClient = new ShelterClient({ serverUrl: "https://hosting.example", token }, networkFailure);
    await expect(networkClient.request("/api/projects")).rejects.not.toThrow(token);
  });
});
