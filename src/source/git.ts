import { promises as fs } from "node:fs";
import path from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";
import type { Logger } from "../observability/logger.js";
import type { SourceAdapter } from "./manager.js";

export interface GitSourceOptions {
  url: string;
  branch: string;
  cacheDir: string;
  authToken?: string | undefined;
  logger: Logger;
}

export class GitSourceAdapter implements SourceAdapter {
  readonly #checkoutPath: string;
  readonly #branch: string;
  readonly #url: string;
  readonly #effectiveUrl: string;
  readonly #logger: Logger;
  #git: SimpleGit | undefined;
  #lastSha: string | null = null;

  constructor(opts: GitSourceOptions) {
    this.#url = opts.url;
    this.#branch = opts.branch;
    this.#logger = opts.logger;
    this.#checkoutPath = path.join(opts.cacheDir, deriveRepoSlug(opts.url));
    this.#effectiveUrl = embedTokenIfHttps(opts.url, opts.authToken);
  }

  async ensure(): Promise<string> {
    await fs.mkdir(path.dirname(this.#checkoutPath), { recursive: true });
    const exists = await this.#looksLikeRepo(this.#checkoutPath);
    if (!exists) {
      this.#logger.info(
        { url: redact(this.#url), branch: this.#branch, dst: this.#checkoutPath },
        "git: cloning",
      );
      const cloner = simpleGit();
      await cloner.clone(this.#effectiveUrl, this.#checkoutPath, [
        "--branch",
        this.#branch,
        "--single-branch",
        "--depth",
        "1",
      ]);
    } else {
      this.#logger.info({ dst: this.#checkoutPath }, "git: existing checkout, fetching");
    }
    this.#git = simpleGit(this.#checkoutPath);
    await this.#git.fetch(["origin", this.#branch]);
    await this.#git.checkout(this.#branch);
    await this.#git.reset(["--hard", `origin/${this.#branch}`]);
    this.#lastSha = await this.#headSha();
    return this.#checkoutPath;
  }

  async update(): Promise<boolean> {
    if (!this.#git) throw new Error("GitSourceAdapter.update called before ensure");
    try {
      await this.#git.fetch(["origin", this.#branch]);
      const before = this.#lastSha;
      const remote = (await this.#git.revparse([`origin/${this.#branch}`])).trim();
      if (before === remote) return false;
      await this.#git.reset(["--hard", `origin/${this.#branch}`]);
      this.#lastSha = remote;
      this.#logger.info({ from: before, to: remote }, "git: pulled new commit(s)");
      return true;
    } catch (err) {
      this.#logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "git: update failed",
      );
      return false;
    }
  }

  path(): string {
    return this.#checkoutPath;
  }

  describe(): string {
    return `git:${redact(this.#url)}#${this.#branch}`;
  }

  async #headSha(): Promise<string | null> {
    if (!this.#git) return null;
    try {
      return (await this.#git.revparse(["HEAD"])).trim();
    } catch {
      return null;
    }
  }

  async #looksLikeRepo(p: string): Promise<boolean> {
    try {
      const s = await fs.stat(path.join(p, ".git"));
      return s.isDirectory() || s.isFile();
    } catch {
      return false;
    }
  }
}

/** Derive a deterministic dir name from a Git URL. */
function deriveRepoSlug(url: string): string {
  const trimmed = url.replace(/\.git$/, "");
  const segments = trimmed.split(/[:/]/).filter(Boolean);
  return (
    segments
      .slice(-2)
      .join("__")
      .replace(/[^A-Za-z0-9_.-]/g, "_") || "repo"
  );
}

/** Embed a PAT into an https URL for transport-level auth. SSH URLs pass through unchanged. */
function embedTokenIfHttps(url: string, token: string | undefined): string {
  if (!token) return url;
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") {
      u.username = "x-access-token";
      u.password = token;
      return u.toString();
    }
  } catch {
    // not a URL (likely git@host:path) — return as-is
  }
  return url;
}

/** Strip credentials from a URL for safe logging. */
function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    return u.toString();
  } catch {
    return url;
  }
}
