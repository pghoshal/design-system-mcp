import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSourceAdapter } from "../../../src/source/local.js";
import { SourceManager } from "../../../src/source/manager.js";
import { handler } from "../../../src/tools/get-usage.js";
import { LayeredCache } from "../../../src/util/lru.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.resolve(__dirname, "..", "..", "fixtures", "design-systems", "sample");

const logger = pino({ level: "silent" });
let manager: SourceManager;
let cache: LayeredCache;
const ctx = () => ({ source: manager, cache, logger, requestId: "get-usage-test" });

beforeAll(async () => {
  cache = new LayeredCache();
  manager = new SourceManager({
    adapter: new LocalSourceAdapter(FIXTURE, logger),
    logger,
    refreshIntervalSec: 60,
  });
  await manager.initial();
}, 30_000);

afterAll(async () => {
  await manager.stop();
});

describe("get_usage platform mappings", () => {
  it("returns generic usage when no platform is requested", async () => {
    const usage = await handler.handle({ id: "component:button" }, ctx());
    expect(usage.package).toBe("@acme/ui");
    expect(usage.importPath).toBe("@acme/ui/button");
    expect(usage.platformUsage).toBeUndefined();
    expect(usage.platformMappings?.length).toBeGreaterThan(0);
  });

  it("prefers an exact framework mapping over a generic platform mapping", async () => {
    const usage = await handler.handle(
      { id: "component:button", platform: "web", framework: "react" },
      ctx(),
    );
    expect(usage.package).toBe("@acme/react-ui");
    expect(usage.importPath).toBe("@acme/react-ui/button");
    expect(usage.platformUsage).toMatchObject({
      platform: "web",
      framework: "react",
      component: "Button",
    });
  });

  it("uses a generic platform mapping when the framework has no exact mapping", async () => {
    const usage = await handler.handle(
      { id: "component:button", platform: "web", framework: "vue" },
      ctx(),
    );
    expect(usage.package).toBe("@acme/ui");
    expect(usage.importPath).toBe("@acme/ui/button");
    expect(usage.platformUsage).toMatchObject({
      platform: "web",
      component: "Button",
    });
  });

  it("returns native component guidance instead of root web imports", async () => {
    const usage = await handler.handle(
      { id: "component:button", platform: "react-native", framework: "react-native" },
      ctx(),
    );
    expect(usage.package).toBe("@acme/react-native-ui");
    expect(usage.importPath).toBe("@acme/react-native-ui/button");
    expect(usage.platformUsage?.notes.join(" ")).toContain("instead of recreating");
  });

  it("does not fall back to web importPath for platforms without import paths", async () => {
    const usage = await handler.handle(
      { id: "component:button", platform: "flutter", framework: "flutter" },
      ctx(),
    );
    expect(usage.package).toBe("acme_ui");
    expect(usage.importPath).toBeUndefined();
    expect(usage.platformUsage).toMatchObject({
      platform: "flutter",
      framework: "flutter",
      component: "AcmeButton",
    });
  });

  it("does not fall back to generic web imports for unsupported platforms", async () => {
    const usage = await handler.handle(
      { id: "component:button", platform: "desktop", framework: "electron" },
      ctx(),
    );
    expect(usage.package).toBeUndefined();
    expect(usage.importPath).toBeUndefined();
    expect(usage.platformUsage).toBeUndefined();
  });
});
