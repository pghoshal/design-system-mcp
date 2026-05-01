import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "../observability/logger.js";
import type { SourceAdapter } from "./manager.js";

export class LocalSourceAdapter implements SourceAdapter {
  #lastSignature = "";

  constructor(
    private readonly absPath: string,
    private readonly logger: Logger,
  ) {}

  async ensure(): Promise<string> {
    const stat = await fs.stat(this.absPath);
    if (!stat.isDirectory()) {
      throw new Error(`DS_MCP_SOURCE_PATH is not a directory: ${this.absPath}`);
    }
    this.#lastSignature = await this.computeSignature();
    return this.absPath;
  }

  async update(): Promise<boolean> {
    const sig = await this.computeSignature();
    const changed = sig !== this.#lastSignature;
    if (changed) this.#lastSignature = sig;
    return changed;
  }

  path(): string {
    return this.absPath;
  }

  describe(): string {
    return `local:${this.absPath}`;
  }

  /**
   * Cheap content fingerprint: aggregate path + mtime over relevant files.
   * Not cryptographically strong; sufficient to detect changes between polls.
   */
  private async computeSignature(): Promise<string> {
    const targets = ["manifest.json", "tokens", "docs", "components", "prompts", "rules"];
    const parts: string[] = [];
    for (const t of targets) {
      const full = path.join(this.absPath, t);
      await this.collectMtimes(full, parts);
    }
    parts.sort();
    return parts.join("|");
  }

  private async collectMtimes(start: string, out: string[]): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(start);
    } catch {
      return;
    }
    if (stat.isFile()) {
      out.push(`${start}:${stat.mtimeMs}`);
      return;
    }
    if (!stat.isDirectory()) return;
    const entries = await fs.readdir(start, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(start, ent.name);
      if (ent.isDirectory()) {
        await this.collectMtimes(full, out);
      } else if (ent.isFile()) {
        const s = await fs.stat(full);
        out.push(`${full}:${s.mtimeMs}`);
      }
    }
  }
}
