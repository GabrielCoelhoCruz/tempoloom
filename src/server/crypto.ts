// Encrypts secrets at rest (OAuth refresh and access tokens) with AES-256-GCM.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export class SecretBox {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    this.#key = Buffer.from(base64Key, "base64");
    if (this.#key.length !== 32) throw new Error("SecretBox key must be 32 bytes");
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString("base64url"),
      tag.toString("base64url"),
      data.toString("base64url"),
    ].join(".");
  }

  open(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(".");
    if (version !== VERSION || !iv || !tag || data === undefined) {
      throw new Error("Unknown secret format");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}
