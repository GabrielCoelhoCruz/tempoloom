import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

/** Parses the JSON body with a schema, or fails the request with 400. */
export async function jsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  return parsed(schema, await rawBody(c));
}

/** The JSON body as sent, before any schema. */
export async function rawBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => {
    throw new HTTPException(400, { message: "Body must be JSON" });
  });
}

/**
 * An edit body (automations-overview.md rule 11, decision "an edit sends only
 * the fields it changed"): the fields it sends over the stored ones, then
 * parsed as a full body.
 */
export function editBody<S extends z.ZodType>(
  schema: S,
  stored: Record<string, unknown>,
  raw: unknown,
): z.infer<S> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new HTTPException(400, { message: "Body must be a JSON object" });
  return parsed(schema, { ...stored, ...raw });
}

/** `raw` parsed with a schema, or a 400 with the bad fields. */
function parsed<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HTTPException(400, {
      res: Response.json(
        {
          error: "invalid_body",
          issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        { status: 400 },
      ),
    });
  }
  return result.data;
}

export function notFound(what: string): never {
  throw new HTTPException(404, {
    res: Response.json({ error: "not_found", what }, { status: 404 }),
  });
}
