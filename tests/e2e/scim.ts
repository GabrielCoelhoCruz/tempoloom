// A SCIM 2.0 client, as an identity provider uses it to push the directory to
// Tempoloom (docs/specs/admin-sso-provisioning.md). Plain HTTP with a bearer token.
import { BASE_URL } from "./fixtures.ts";

export const ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const PRODUCT = "urn:tempoloom:params:scim:schemas:extension:2.0:User";

export interface ScimUser {
  userName: string;
  displayName?: string;
  title?: string;
  active?: boolean;
  department?: string;
  /** SCIM id of the manager. */
  managerId?: string;
  location?: string;
  /** Extra attributes in a custom extension schema. */
  custom?: Record<string, string>;
}

export function scim(token: string, base = BASE_URL) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/scim/v2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  const resource = (u: ScimUser) => ({
    schemas: [
      "urn:ietf:params:scim:schemas:core:2.0:User",
      ENTERPRISE,
      ...(u.location ? [PRODUCT] : []),
      ...(u.custom ? ["urn:example:params:scim:schemas:extension:custom:1.0:User"] : []),
    ],
    userName: u.userName,
    displayName: u.displayName ?? u.userName,
    emails: [{ value: u.userName, primary: true, type: "work" }],
    active: u.active ?? true,
    ...(u.title ? { title: u.title } : {}),
    [ENTERPRISE]: {
      ...(u.department ? { department: u.department } : {}),
      ...(u.managerId ? { manager: { value: u.managerId } } : {}),
    },
    ...(u.location ? { [PRODUCT]: { location: u.location } } : {}),
    ...(u.custom ? { "urn:example:params:scim:schemas:extension:custom:1.0:User": u.custom } : {}),
  });
  return {
    call,
    /** Creates a user and returns its SCIM id. */
    async create(u: ScimUser): Promise<string> {
      const r = await call("POST", "/Users", resource(u));
      if (r.status !== 201) throw new Error(`SCIM create ${r.status}: ${JSON.stringify(r.body)}`);
      return String(r.body.id);
    },
    replace: (id: string, u: ScimUser) => call("PUT", `/Users/${id}`, resource(u)),
    patch: (id: string, ops: { op: string; path?: string; value: unknown }[]) =>
      call("PATCH", `/Users/${id}`, {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: ops,
      }),
    find: (userName: string) =>
      call("GET", `/Users?filter=${encodeURIComponent(`userName eq "${userName}"`)}`),
    remove: (id: string) => call("DELETE", `/Users/${id}`),
  };
}
