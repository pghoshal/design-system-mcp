import { createHash, timingSafeEqual } from "node:crypto";

/**
 * API-key validation for HTTP mode.
 *
 * Configured via `DS_MCP_API_KEYS` (comma-separated list of SHA-256 hex digests).
 * On request, we SHA-256 the presented key and compare against each configured
 * digest with `timingSafeEqual` to avoid timing leaks.
 *
 * Why SHA-256 not bcrypt: API keys are high-entropy random strings, not human
 * passwords. SHA-256 is sufficient for verifying knowledge of a key, and avoids
 * adding bcrypt as a dependency.
 *
 * To compute a hash for an env file: `printf '%s' '<api-key>' | shasum -a 256`
 */
export class ApiKeyValidator {
  readonly #digests: Buffer[];

  constructor(commaSeparatedHashes: string) {
    this.#digests = commaSeparatedHashes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((hex) => Buffer.from(hex, "hex"));
    for (const d of this.#digests) {
      if (d.length !== 32) {
        throw new Error("DS_MCP_API_KEYS entries must be SHA-256 hex digests (64 hex chars each)");
      }
    }
    if (this.#digests.length === 0) {
      throw new Error("DS_MCP_API_KEYS is empty after parsing");
    }
  }

  validate(presented: string | undefined): boolean {
    if (!presented) return false;
    const candidate = createHash("sha256").update(presented).digest();
    let ok = false;
    for (const d of this.#digests) {
      if (d.length === candidate.length && timingSafeEqual(d, candidate)) ok = true;
    }
    return ok;
  }

  static extractBearer(header: string | undefined): string | undefined {
    if (!header) return undefined;
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return m?.[1];
  }
}
