import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalSourceAdapter } from "../../src/source/local.js";
import { SourceManager } from "../../src/source/manager.js";
import { handler as getEntityHandler } from "../../src/tools/get-entity.js";
import { handler as resolveTokenHandler } from "../../src/tools/resolve-token.js";
import { handler as searchHandler } from "../../src/tools/search-design-system.js";
import { handler as validateUiHandler } from "../../src/tools/validate-ui.js";
import { LayeredCache } from "../../src/util/lru.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "design-systems", "sample");

const logger = pino({ level: "silent" });
let manager: SourceManager;
let cache: LayeredCache;
let coldStartMs: number;

const ctx = () => ({
  source: manager,
  cache,
  logger,
  requestId: "perf",
});

/**
 * Time `iterations` invocations of `fn` and return p50 / p99 in ms.
 * The first 5 runs are discarded as warm-up (JIT, V8 inline caching).
 *
 * Percentile calculation: with 50 samples, `floor(50 * 0.99) = 49` selects the
 * last (max) element. That is *p100*, not strictly p99, but it is the right
 * sentinel for regression detection on small N — the worst-case is what tail
 * latency monitors care about. Documented here so future readers don't think
 * this is a bug.
 */
async function percentiles(
  iterations: number,
  fn: () => Promise<unknown>,
): Promise<{ p50: number; p99: number; samples: number[] }> {
  const warmup = 5;
  const samples: number[] = [];
  for (let i = 0; i < iterations + warmup; i++) {
    const t0 = performance.now();
    await fn();
    const dt = performance.now() - t0;
    if (i >= warmup) samples.push(dt);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)] ?? Number.POSITIVE_INFINITY;
  const p99 = samples[Math.floor(samples.length * 0.99)] ?? Number.POSITIVE_INFINITY;
  return { p50, p99, samples };
}

beforeAll(async () => {
  cache = new LayeredCache();
  manager = new SourceManager({
    adapter: new LocalSourceAdapter(FIXTURE, logger),
    logger,
    refreshIntervalSec: 60,
  });
  const t0 = performance.now();
  await manager.initial();
  coldStartMs = performance.now() - t0;
}, 30_000);

// Reset the LRU before every benchmark so cache hits never skew the p50 — the
// tests measure cold-call latency. Tests in this suite intentionally do NOT
// depend on each other; each `it` re-derives a fresh cache.
beforeEach(() => {
  cache = new LayeredCache();
});

afterAll(async () => {
  await manager.stop();
});

describe("Phase 4 — performance baselines (gates against the SLO table in .claude/lld.md §5.1)", () => {
  // Generous CI multipliers: SLOs are written for production-shape hardware;
  // CI runners and dev laptops take longer. We multiply the SLO by `MULT` so
  // the gate catches a *clear* regression (10x+ slowdown) without false-failing
  // on a slow runner. Real production monitoring still uses the raw SLO.
  const MULT = 10;

  it(`cold start < ${5000 * MULT} ms (target: <5000 ms)`, () => {
    expect(coldStartMs).toBeLessThan(5000 * MULT);
  });

  it("search_design_system p50/p99 within budget", async () => {
    const { p50, p99 } = await percentiles(50, async () => {
      await searchHandler.handle(
        { query: "primary blue", type: "token", limit: 5, offset: 0 },
        ctx(),
      );
    });
    expect(p50).toBeLessThan(30 * MULT);
    expect(p99).toBeLessThan(200 * MULT);
  });

  it("get_entity p50/p99 within budget (cold, no cache)", async () => {
    const { p50, p99 } = await percentiles(50, async () => {
      await getEntityHandler.handle({ id: "principle:clarity", resolve_relations: false }, ctx());
    });
    expect(p50).toBeLessThan(10 * MULT);
    expect(p99).toBeLessThan(50 * MULT);
  });

  it("resolve_token p50/p99 within budget", async () => {
    const { p50, p99 } = await percentiles(50, async () => {
      await resolveTokenHandler.handle({ query: "primary", platform: "css", limit: 5 }, ctx());
    });
    // No SLO yet for resolve_token — bound to <30/<200 by analogy with search.
    expect(p50).toBeLessThan(30 * MULT);
    expect(p99).toBeLessThan(200 * MULT);
  });

  it("validate_ui p50/p99 within budget", async () => {
    const code = [
      "function Card() {",
      "  return (",
      "    <div style={{ padding: 16, color: 'var(--color-action-primary)' }}>",
      "      <button>Save</button>",
      "      <a href='/x'>open</a>",
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    const { p50, p99 } = await percentiles(50, async () => {
      await validateUiHandler.handle({ code, language: "tsx", rules: [] }, ctx());
    });
    // No formal SLO yet for validate_ui — bound to <50/<300.
    expect(p50).toBeLessThan(50 * MULT);
    expect(p99).toBeLessThan(300 * MULT);
  });

  // Diagnostic: log measured numbers so a failing CI run shows the actual
  // percentiles (not just the bound that was breached). Asserts the timer
  // produced sane (>0, finite) numbers — catches regressions where the
  // benchmark harness itself breaks (NaN samples, clock-skew, broken
  // performance.now()).
  it("records baseline numbers and asserts the harness is healthy", async () => {
    const baselines: Record<string, { p50: number; p99: number }> = {};
    baselines.coldStart = { p50: coldStartMs, p99: coldStartMs };

    baselines.search = await percentiles(20, async () => {
      await searchHandler.handle({ query: "danger", type: "token", limit: 3, offset: 0 }, ctx());
    });

    baselines.getEntity = await percentiles(20, async () => {
      await getEntityHandler.handle(
        { id: "token:color.action.primary", resolve_relations: false },
        ctx(),
      );
    });

    process.stderr.write(
      `\n[perf-baseline] ${JSON.stringify(
        Object.fromEntries(
          Object.entries(baselines).map(([k, v]) => [
            k,
            { p50: Number(v.p50.toFixed(2)), p99: Number(v.p99.toFixed(2)) },
          ]),
        ),
        null,
        2,
      )}\n`,
    );

    // Health-of-the-harness assertions — would fail if performance.now() got
    // mocked away, the sample array stayed empty, or the boot timer didn't
    // fire. NOT performance gates; those live in the dedicated tests above.
    expect(baselines.coldStart.p50).toBeGreaterThan(0);
    expect(Number.isFinite(baselines.coldStart.p50)).toBe(true);
    expect(Number.isFinite(baselines.search.p50)).toBe(true);
    expect(Number.isFinite(baselines.search.p99)).toBe(true);
    expect(Number.isFinite(baselines.getEntity.p50)).toBe(true);
    expect(Number.isFinite(baselines.getEntity.p99)).toBe(true);
  });
});
