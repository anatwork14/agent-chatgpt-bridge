import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { BridgeError } from "../../core/errors";
import type { ProviderHealthObservation } from "../../providers/health";

export interface ProviderHealthApiOptions {
  apiToken?: string;
  listProviderHealth: () => ProviderHealthObservation[] | Promise<ProviderHealthObservation[]>;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createProviderHealthApi(options: ProviderHealthApiOptions) {
  const app = new Hono().basePath("/bridge/v1");

  app.use("*", async (c, next) => {
    if (options.apiToken && !tokenMatches(c.req.header("authorization"), options.apiToken)) {
      return c.json(new BridgeError(
        "authentication_required",
        "A valid local bridge bearer token is required",
        false,
      ).toJSON(), 401);
    }
    await next();
  });

  app.get("/providers/health", async c => {
    return c.json({ providers: await options.listProviderHealth() });
  });

  return app;
}
