import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSourceAdapter } from "../../../src/source/local.js";
import { SourceManager } from "../../../src/source/manager.js";
import { handler } from "../../../src/tools/get-component-source.js";
import { LayeredCache } from "../../../src/util/lru.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.resolve(__dirname, "..", "..", "fixtures", "design-systems", "sample");

const logger = pino({ level: "silent" });
let manager: SourceManager;
let cache: LayeredCache;
const ctx = () => ({ source: manager, cache, logger, requestId: "get-component-source-test" });

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

describe("get_component_source", () => {
  it("returns existing implementation files for a component", async () => {
    const result = await handler.handle({ id: "component:card" }, ctx());
    expect(result.sourcePath).toBe("components/Card/component.json");
    expect(result.files.some((file) => file.path === "components/Card/Card.tsx")).toBe(true);
    expect(result.files.some((file) => file.path === "components/Card/card.css")).toBe(true);
    expect(result.files.some((file) => file.path === "components/Card/Card.stories.tsx")).toBe(
      true,
    );
    expect(result.files.find((file) => file.path.endsWith("Card.tsx"))?.content).toContain(
      "CardProps",
    );
  });

  it("can omit story files", async () => {
    const result = await handler.handle({ id: "component:card", includeStories: false }, ctx());
    expect(result.files.some((file) => file.path.includes(".stories."))).toBe(false);
  });

  it("truncates large files according to the requested byte limit", async () => {
    const result = await handler.handle({ id: "component:card", maxBytesPerFile: 512 }, ctx());
    expect(result.files.every((file) => file.content.length <= 512)).toBe(true);
  });
});
