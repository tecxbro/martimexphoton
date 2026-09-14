import type { Request, RequestHandler, Response } from "express";

const ALLOWED_FETCH_SITES = new Set(["same-origin", "same-site", "none"]);

function requestTargetOrigin(request: Request): string | undefined {
  const host = request.get("host");
  if (host === undefined || host.length > 512) {
    return undefined;
  }

  const forwardedProtocol = request
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim();
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : request.protocol;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return undefined;
  }
}

function submittedOrigin(request: Request): string | undefined {
  const origin = request.get("origin");
  if (origin === undefined) {
    return undefined;
  }
  try {
    return new URL(origin).origin;
  } catch {
    return undefined;
  }
}

function hasAllowedOrigin(
  request: Request,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  const origin = submittedOrigin(request);
  if (origin === undefined) {
    return false;
  }
  return origin === requestTargetOrigin(request) || trustedOrigins.has(origin);
}

function hasAllowedFetchSite(request: Request): boolean {
  const fetchSite = request.get("sec-fetch-site");
  return fetchSite === undefined || ALLOWED_FETCH_SITES.has(fetchSite);
}

function sendForbidden(response: Response): void {
  response.set("cache-control", "no-store");
  response.status(403).json({ error: "FORBIDDEN" });
}

/**
 * Blocks drive-by browser mutations without treating the public page as auth.
 *
 * `trustedOrigins` lists extra exact origins that may submit setup requests.
 * Use it only for a host that serves this dashboard through its own
 * authenticated proxy on a different origin.
 */
export function requireSameOrigin(
  trustedOrigins: readonly string[] = [],
): RequestHandler {
  const trusted = new Set(trustedOrigins);
  return (request, response, next) => {
    if (!hasAllowedOrigin(request, trusted) || !hasAllowedFetchSite(request)) {
      sendForbidden(response);
      return;
    }
    next();
  };
}
