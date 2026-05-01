import { buildBundle } from "../bundle/builder.js";
import type { Bundle } from "../bundle/types.js";
import type { Logger } from "../observability/logger.js";
import { AtomicRef } from "../util/atomic-ref.js";
import { ToolError } from "../util/errors.js";

export interface SourceAdapter {
  /** Ensure source is on disk and ready to be built. Returns the absolute path. */
  ensure(): Promise<string>;
  /** Pull updates / re-check the source. Returns true if content changed since last check. */
  update(): Promise<boolean>;
  /** Path to the on-disk checkout. */
  path(): string;
  /** Symbolic name for logs. */
  describe(): string;
}

export interface SourceManagerOptions {
  adapter: SourceAdapter;
  logger: Logger;
  refreshIntervalSec: number;
}

export class SourceManager {
  readonly #ref = new AtomicRef<Bundle | null>(null);
  readonly #opts: SourceManagerOptions;
  #timer: NodeJS.Timeout | undefined;
  #refreshing = false;

  constructor(opts: SourceManagerOptions) {
    this.#opts = opts;
  }

  /** Boot: ensure the source is present and build the first bundle. */
  async initial(): Promise<void> {
    const { adapter, logger } = this.#opts;
    logger.info({ source: adapter.describe() }, "source manager: initial load");
    const repoPath = await adapter.ensure();
    const bundle = await buildBundle({ sourcePath: repoPath, logger });
    this.#ref.swap(bundle);
  }

  startRefreshLoop(): void {
    if (this.#timer) return;
    const ms = this.#opts.refreshIntervalSec * 1000;
    this.#timer = setInterval(() => {
      void this.refresh().catch((err) => {
        this.#opts.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "scheduled refresh failed",
        );
      });
    }, ms);
    if (typeof this.#timer.unref === "function") this.#timer.unref();
    this.#opts.logger.info({ intervalSec: this.#opts.refreshIntervalSec }, "refresh loop started");
  }

  /** Force a refresh now. Safe to call concurrently; second caller no-ops. */
  async refresh(): Promise<{ changed: boolean; version: string }> {
    if (this.#refreshing) {
      const cur = this.#ref.get();
      return { changed: false, version: cur?.version ?? "no-bundle" };
    }
    this.#refreshing = true;
    try {
      const { adapter, logger } = this.#opts;
      const changed = await adapter.update();
      if (!changed) {
        const cur = this.#ref.get();
        return { changed: false, version: cur?.version ?? "no-bundle" };
      }
      const repoPath = adapter.path();
      const bundle = await buildBundle({ sourcePath: repoPath, logger });
      const prev = this.#ref.swap(bundle);
      logger.info({ from: prev?.version ?? "(none)", to: bundle.version }, "bundle swapped");
      return { changed: true, version: bundle.version };
    } finally {
      this.#refreshing = false;
    }
  }

  current(): Bundle {
    const b = this.#ref.get();
    if (!b) throw new ToolError("bundle_unavailable", "no bundle loaded");
    return b;
  }

  hasBundle(): boolean {
    return this.#ref.get() !== null;
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}
