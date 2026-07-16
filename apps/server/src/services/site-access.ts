import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { verifyPassword } from "../lib/security.js";
import type { DomainRow } from "../types/models.js";

export const SITE_ACCESS_COOKIE = "shelter_site_access";
export const SITE_ACCESS_PATH = "/_shelter/access";

interface SiteAccessClaims {
  domainId: string;
  version: number;
  expiresAt: number;
}

function signature(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret)
    .update("shelter:site-access:v1\0")
    .update(payload)
    .digest();
}

function issueAccessToken(config: AppConfig, domain: DomainRow): string {
  const claims: SiteAccessClaims = {
    domainId: domain.id,
    version: domain.access_session_version ?? 1,
    expiresAt: Date.now() + (domain.access_session_ttl_hours ?? 168) * 60 * 60 * 1000
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `v1.${payload}.${signature(config.APP_SECRET, payload).toString("base64url")}`;
}

function validAccessToken(config: AppConfig, domain: DomainRow, token: string | undefined): boolean {
  if (!token) return false;
  const [version, payload, suppliedEncoded, extra] = token.split(".");
  if (version !== "v1" || !payload || !suppliedEncoded || extra) return false;
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedEncoded, "base64url");
  } catch {
    return false;
  }
  const expected = signature(config.APP_SECRET, payload);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<SiteAccessClaims>;
    return claims.domainId === domain.id
      && claims.version === (domain.access_session_version ?? 1)
      && typeof claims.expiresAt === "number"
      && Number.isSafeInteger(claims.expiresAt)
      && claims.expiresAt > Date.now();
  } catch {
    return false;
  }
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function hostname(value: string): string {
  const first = value.split(",")[0]?.trim().toLowerCase() ?? "";
  if (first.startsWith("[")) return first.slice(1, first.indexOf("]"));
  return first.split(":")[0] ?? "";
}

function requestHostname(request: FastifyRequest, forwarded: boolean): string {
  return hostname(forwarded
    ? headerValue(request.headers["x-forwarded-host"])
    : headerValue(request.headers.host));
}

function uniqueAccessCookie(request: FastifyRequest): string | undefined {
  const occurrences = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SITE_ACCESS_COOKIE}=`));
  return occurrences.length === 1 ? request.cookies[SITE_ACCESS_COOKIE] : undefined;
}

function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048 || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.startsWith(SITE_ACCESS_PATH)) return "/";
  return value;
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function prefersGerman(request: FastifyRequest): boolean {
  return headerValue(request.headers["accept-language"]).toLowerCase().split(",")
    .some((language) => language.trim().startsWith("de"));
}

function renderAccessPage(
  request: FastifyRequest,
  domain: DomainRow,
  projectName: string,
  returnPath: string,
  invalidPassword = false
): string {
  const de = prefersGerman(request);
  const title = de ? "Diese Seite ist geschützt" : "This site is protected";
  const description = de
    ? "Gib das Passwort ein, das du zusammen mit diesem Link erhalten hast."
    : "Enter the password that was shared with this link.";
  const label = de ? "Passwort" : "Password";
  const placeholder = de ? "Website-Passwort" : "Site password";
  const submit = de ? "Seite öffnen" : "Open site";
  const error = de ? "Das Passwort ist nicht korrekt." : "That password is not correct.";
  const privacy = de
    ? "Der Zugriff gilt nur für diese Domain und läuft automatisch ab."
    : "Access applies only to this domain and expires automatically.";

  return `<!doctype html>
<html lang="${de ? "de" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
  <title>${html(projectName)} · Shelter</title>
  <style>
    :root{color-scheme:light dark;--bg:#f5f6f3;--card:rgba(255,255,255,.88);--ink:#172018;--muted:#687069;--line:rgba(23,32,24,.12);--accent:#78d65b;--accent-ink:#10220d;--danger:#c23939;--shadow:0 24px 80px rgba(21,31,20,.14)}
    @media(prefers-color-scheme:dark){:root{--bg:#0b0d0b;--card:rgba(21,24,21,.9);--ink:#f2f5f1;--muted:#9da69e;--line:rgba(255,255,255,.11);--accent:#80dd60;--accent-ink:#10220d;--danger:#ff8b85;--shadow:0 28px 90px rgba(0,0,0,.46)}}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% 0,rgba(120,214,91,.14),transparent 34rem),var(--bg);color:var(--ink);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
    main{min-height:100vh;display:grid;place-items:center;padding:28px}.shell{width:min(100%,430px)}
    .brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:22px;font-size:14px;font-weight:680;letter-spacing:-.01em}.frog{position:relative;width:31px;height:27px;border-radius:11px 11px 13px 13px;background:var(--accent);box-shadow:inset 0 -4px 0 rgba(25,76,15,.12)}.frog:before,.frog:after{content:"";position:absolute;top:-4px;width:12px;height:12px;border-radius:50%;background:var(--accent);box-shadow:inset 0 0 0 4px var(--ink)}.frog:before{left:2px}.frog:after{right:2px}
    .card{border:1px solid var(--line);border-radius:24px;background:var(--card);padding:30px;box-shadow:var(--shadow);backdrop-filter:blur(18px)}
    .eyebrow{display:inline-flex;align-items:center;gap:7px;margin:0 0 17px;padding:6px 9px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:12px}.dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}
    h1{margin:0;font-size:30px;line-height:1.08;letter-spacing:-.04em}p{margin:12px 0 0;color:var(--muted);font-size:14px;line-height:1.55}.host{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    form{margin-top:26px}label{display:block;margin-bottom:8px;font-size:13px;font-weight:650}input{width:100%;height:48px;border:1px solid ${invalidPassword ? "var(--danger)" : "var(--line)"};border-radius:13px;background:transparent;color:var(--ink);padding:0 14px;font:inherit;outline:none;transition:border-color .18s,box-shadow .18s}input:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(120,214,91,.16)}input::placeholder{color:var(--muted)}
    .error{margin:8px 0 0;color:var(--danger);font-size:13px}button{width:100%;height:48px;margin-top:14px;border:0;border-radius:13px;background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:720;cursor:pointer;transition:transform .16s,filter .16s}button:hover{filter:brightness(1.04);transform:translateY(-1px)}button:active{transform:translateY(0)}
    .privacy{display:flex;gap:8px;margin-top:18px;padding-top:18px;border-top:1px solid var(--line);font-size:12px}.lock{flex:0 0 auto}
    footer{text-align:center;margin-top:18px;color:var(--muted);font-size:12px}footer strong{color:var(--ink)}
  </style>
</head>
<body>
  <main>
    <div class="shell">
      <div class="brand"><span class="frog" aria-hidden="true"></span><span>Shelter</span></div>
      <section class="card">
        <p class="eyebrow"><span class="dot"></span><span class="host">${html(domain.hostname)}</span></p>
        <h1>${title}</h1>
        <p>${description}</p>
        <form method="post" action="${SITE_ACCESS_PATH}/${encodeURIComponent(domain.id)}">
          <input type="hidden" name="returnPath" value="${html(returnPath)}">
          <label for="password">${label}</label>
          <input id="password" name="password" type="password" autocomplete="current-password" placeholder="${placeholder}" required autofocus aria-invalid="${invalidPassword}">
          ${invalidPassword ? `<p class="error" role="alert">${error}</p>` : ""}
          <button type="submit">${submit} →</button>
        </form>
        <p class="privacy"><span class="lock" aria-hidden="true">◈</span><span>${privacy}</span></p>
      </section>
      <footer><strong>${html(projectName)}</strong> · give your code a home</footer>
    </div>
  </main>
</body>
</html>`;
}

function requireMatchingDomainHost(request: FastifyRequest, reply: FastifyReply, domain: DomainRow): boolean {
  if (requestHostname(request, false) === domain.hostname) return true;
  void reply.code(404).type("text/plain").send("Not found");
  return false;
}

export function registerSiteAccessRoutes(
  app: FastifyInstance,
  config: AppConfig,
  database: Database
): void {
  app.get<{ Querystring: { domainId?: string } }>("/api/site-access/authorize", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const domain = request.query.domainId ? database.getDomain(request.query.domainId) : undefined;
    if (
      !domain
      || domain.status !== "active"
      || domain.password_protection_enabled !== 1
      || requestHostname(request, true) !== domain.hostname
    ) {
      return reply.code(403).send();
    }
    if (validAccessToken(config, domain, uniqueAccessCookie(request))) {
      return reply.code(204).send();
    }
    const returnPath = safeReturnPath(headerValue(request.headers["x-forwarded-uri"]));
    const forwardedProtocol = headerValue(request.headers["x-forwarded-proto"]).split(",")[0]?.trim().toLowerCase();
    const protocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? forwardedProtocol : "https";
    const accessUrl = new URL(`${SITE_ACCESS_PATH}/${encodeURIComponent(domain.id)}`, `${protocol}://${domain.hostname}`);
    accessUrl.searchParams.set("returnPath", returnPath);
    return reply
      .code(302)
      // ForwardAuth responses are produced by the internal API service. A
      // relative Location would therefore be resolved by Traefik against
      // http://api:7080 instead of the visitor-facing hostname.
      .header("location", accessUrl.toString())
      .send();
  });

  app.get<{ Params: { domainId: string }; Querystring: { returnPath?: string } }>(
    `${SITE_ACCESS_PATH}/:domainId`,
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("x-robots-tag", "noindex, nofollow, noarchive, nosnippet");
      const domain = database.getDomain(request.params.domainId);
      if (!domain || domain.status !== "active" || domain.password_protection_enabled !== 1) {
        return reply.code(404).type("text/plain").send("Not found");
      }
      if (!requireMatchingDomainHost(request, reply, domain)) return;
      const returnPath = safeReturnPath(request.query.returnPath);
      if (validAccessToken(config, domain, uniqueAccessCookie(request))) {
        return reply.redirect(returnPath);
      }
      const project = database.getProject(domain.project_id);
      return reply.type("text/html; charset=utf-8").send(
        renderAccessPage(request, domain, project?.name ?? domain.hostname, returnPath)
      );
    }
  );

  app.post<{ Params: { domainId: string }; Body: unknown }>(
    `${SITE_ACCESS_PATH}/:domainId`,
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("x-robots-tag", "noindex, nofollow, noarchive, nosnippet");
      const domain = database.getDomain(request.params.domainId);
      if (!domain || domain.status !== "active" || domain.password_protection_enabled !== 1 || !domain.password_hash) {
        return reply.code(404).type("text/plain").send("Not found");
      }
      if (!requireMatchingDomainHost(request, reply, domain)) return;
      const origin = headerValue(request.headers.origin);
      if (origin) {
        try {
          if (new URL(origin).hostname.toLowerCase() !== domain.hostname) {
            return reply.code(403).type("text/plain").send("Forbidden");
          }
        } catch {
          return reply.code(403).type("text/plain").send("Forbidden");
        }
      }
      const input = z.object({
        password: z.string().min(1).max(256),
        returnPath: z.string().optional()
      }).strict().safeParse(request.body);
      const returnPath = safeReturnPath(input.success ? input.data.returnPath : undefined);
      const project = database.getProject(domain.project_id);
      if (!input.success || !await verifyPassword(input.data.password, domain.password_hash)) {
        return reply.code(401).type("text/html; charset=utf-8").send(
          renderAccessPage(request, domain, project?.name ?? domain.hostname, returnPath, true)
        );
      }
      const maxAge = (domain.access_session_ttl_hours ?? 168) * 60 * 60;
      reply.setCookie(SITE_ACCESS_COOKIE, issueAccessToken(config, domain), {
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge
      });
      return reply.code(303).header("location", returnPath).send();
    }
  );
}
