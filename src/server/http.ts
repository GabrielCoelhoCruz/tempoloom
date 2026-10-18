import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

/** Parses the JSON body with a schema, or fails the request with 400. */
export async function jsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const raw: unknown = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: "Body must be JSON" });
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, {
      res: Response.json(
        {
          error: "invalid_body",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        { status: 400 },
      ),
    });
  }
  return parsed.data;
}

export function notFound(what: string): never {
  throw new HTTPException(404, {
    res: Response.json({ error: "not_found", what }, { status: 404 }),
  });
}
