import pino from "pino";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config.js";
import { AtomicRef } from "../../src/util/atomic-ref.js";
import { ToolError } from "../../src/util/errors.js";
import { newRequestId } from "../../src/util/ids.js";
import { LayeredCache } from "../../src/util/lru.js";

const _silent = pino({ level: "silent" });

describe("smoke", () => {
  describe("config", () => {
    it("defaults are valid with local source", () => {
      const parsed = ConfigSchema.safeParse({
        DS_MCP_SOURCE_MODE: "local",
        DS_MCP_SOURCE_PATH: "/tmp/ds",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects git mode without URL", () => {
      const parsed = ConfigSchema.safeParse({ DS_MCP_SOURCE_MODE: "git" });
      expect(parsed.success).toBe(false);
    });

    it("rejects local mode without path", () => {
      const parsed = ConfigSchema.safeParse({ DS_MCP_SOURCE_MODE: "local" });
      expect(parsed.success).toBe(false);
    });

    it("rejects apikey auth without keys", () => {
      const parsed = ConfigSchema.safeParse({
        DS_MCP_SOURCE_MODE: "local",
        DS_MCP_SOURCE_PATH: "/tmp/ds",
        DS_MCP_AUTH_MODE: "apikey",
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("AtomicRef", () => {
    it("get + swap return the previous value", () => {
      const ref = new AtomicRef<number>(1);
      expect(ref.get()).toBe(1);
      const prev = ref.swap(2);
      expect(prev).toBe(1);
      expect(ref.get()).toBe(2);
    });
  });

  describe("ToolError", () => {
    it("preserves code and message", () => {
      const err = new ToolError("not_found", "missing");
      expect(err.code).toBe("not_found");
      expect(err.message).toBe("missing");
    });
  });

  describe("ids", () => {
    it("generates uuid-shaped strings", () => {
      const id = newRequestId();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe("LayeredCache", () => {
    it("caches values keyed by bundleVersion", async () => {
      const cache = new LayeredCache({ ttlMs: 60_000 });
      const ctx = { bundleVersion: "v1" };
      let computed = 0;
      const r1 = await cache.fetchOrCompute(ctx, "k", 60_000, () => {
        computed++;
        return 42;
      });
      const r2 = await cache.fetchOrCompute(ctx, "k", 60_000, () => {
        computed++;
        return 42;
      });
      expect(r1).toBe(42);
      expect(r2).toBe(42);
      expect(computed).toBe(1);
    });

    it("isolates entries across bundleVersions", async () => {
      const cache = new LayeredCache({ ttlMs: 60_000 });
      let computed = 0;
      const v1 = await cache.fetchOrCompute({ bundleVersion: "v1" }, "k", 60_000, () => {
        computed++;
        return "a";
      });
      const v2 = await cache.fetchOrCompute({ bundleVersion: "v2" }, "k", 60_000, () => {
        computed++;
        return "b";
      });
      expect(v1).toBe("a");
      expect(v2).toBe("b");
      expect(computed).toBe(2);
    });
  });
});
