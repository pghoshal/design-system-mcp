import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitSourceAdapter } from "../../src/source/git.js";
import { SourceManager } from "../../src/source/manager.js";

const logger = pino({ level: "silent" });

let workspace: string | undefined;
let upstreamUrl: string;
let seedDir: string;
let cacheDir: string;
let manager: SourceManager;

const SEED_TOKENS_V1 = JSON.stringify(
  {
    color: {
      blue: { 500: { $value: "#2563EB", $type: "color", $description: "Brand blue 500" } },
    },
  },
  null,
  2,
);

const SEED_PRINCIPLE = `---
id: principle:clarity
type: principle
title: Clarity
summary: Be clear, not clever.
tags: [principle]
---

# Clarity

Use plain language and obvious affordances.
`;

const SEED_MANIFEST = JSON.stringify(
  {
    schemaVersion: "1.0.0",
    schema: {
      types: {
        token: { description: "Design token", searchable: ["name", "summary", "tags"] },
        principle: {
          description: "Design principle",
          searchable: ["title", "summary", "body", "tags"],
        },
      },
      relations: {},
    },
  },
  null,
  2,
);

async function writeFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

async function setupSeed(branch: string): Promise<void> {
  await fs.mkdir(seedDir, { recursive: true });
  const git = simpleGit(seedDir);
  // `git init` defaults to "master" or "main" depending on git config; force
  // the working clone onto the configured branch via checkoutLocalBranch
  // *after* the first commit. This avoids depending on `--initial-branch`
  // which only landed in git 2.28 (July 2020); some CI images still ship 2.27.
  await git.init();
  await git.addConfig("user.name", "ds-mcp test");
  await git.addConfig("user.email", "ds-mcp@test.invalid");
  await git.addConfig("commit.gpgsign", "false");

  await writeFile(path.join(seedDir, "manifest.json"), SEED_MANIFEST);
  await writeFile(path.join(seedDir, "tokens", "core.tokens.json"), SEED_TOKENS_V1);
  await writeFile(path.join(seedDir, "docs", "principles", "01-clarity.md"), SEED_PRINCIPLE);

  await git.add(".");
  await git.commit("seed: initial design system");
  // Move whatever the default branch happened to be onto our chosen name.
  await git.branch(["-m", branch]);
  await git.addRemote("origin", upstreamUrl);
  await git.push(["--set-upstream", "origin", branch]);
}

async function commitAndPush(message: string, files: Record<string, string>): Promise<string> {
  const git = simpleGit(seedDir);
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(seedDir, rel), content);
  }
  await git.add(".");
  await git.commit(message);
  await git.push();
  return (await git.revparse(["HEAD"])).trim();
}

beforeAll(async () => {
  // Create the workspace FIRST so a later setup failure still leaves a path
  // for afterAll to clean up.
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ds-mcp-git-test-"));
  const upstreamPath = path.join(workspace, "upstream.git");
  seedDir = path.join(workspace, "seed");
  cacheDir = path.join(workspace, "cache");

  // Bare upstream that GitSourceAdapter will clone from. `--bare` is supported
  // on every git release we'd plausibly run on; do not pass `--initial-branch`.
  await fs.mkdir(upstreamPath, { recursive: true });
  await simpleGit(upstreamPath).init(["--bare"]);
  upstreamUrl = pathToFileURL(upstreamPath).toString();

  await setupSeed("main");

  manager = new SourceManager({
    adapter: new GitSourceAdapter({
      url: upstreamUrl,
      branch: "main",
      cacheDir,
      logger,
    }),
    logger,
    refreshIntervalSec: 60,
  });
  await manager.initial();
}, 60_000);

afterAll(async () => {
  if (manager) await manager.stop();
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

describe("Phase 4 — git source integration", () => {
  it("clones the bare repo on initial() and indexes the seed bundle", () => {
    const bundle = manager.current();
    expect(bundle.entities.has("principle:clarity")).toBe(true);
    expect(bundle.entities.has("token:color.blue.500")).toBe(true);
    // gitSha is the short (7-char) SHA from `simple-git` revparse, narrowed to
    // hex. Asserting the shape catches regressions where #headSha returns a
    // truncated/garbage value silently (e.g. an error message).
    expect(bundle.gitSha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("places the checkout under the configured cacheDir", async () => {
    const stat = await fs.stat(cacheDir);
    expect(stat.isDirectory()).toBe(true);
    const entries = await fs.readdir(cacheDir);
    expect(entries.length).toBe(1);
  });

  it("clone is shallow at boot (--depth 1 contract)", async () => {
    // This test must run before any other test that pushes new upstream
    // commits, since beforeAll's checkout is shared. We assert the boot
    // state of the shallow clone here; a separate test below pushes commits
    // and verifies the shallow contract survives refresh.
    const entries = await fs.readdir(cacheDir);
    const checkoutPath = path.join(cacheDir, entries[0] ?? "");
    const checkoutGit = simpleGit(checkoutPath);
    const count = Number((await checkoutGit.raw(["rev-list", "--count", "HEAD"])).trim());
    expect(count).toBe(1);
    const shallowFileExists = await fs
      .stat(path.join(checkoutPath, ".git", "shallow"))
      .then(() => true)
      .catch(() => false);
    expect(shallowFileExists).toBe(true);
  });

  it("refresh() returns changed=false when remote has no new commits", async () => {
    const r = await manager.refresh();
    expect(r.changed).toBe(false);
  });

  it("refresh() picks up new upstream commits and rebuilds the bundle", async () => {
    const versionBefore = manager.current().version;
    const shaBefore = manager.current().gitSha;

    await commitAndPush("add danger token + a new principle", {
      "tokens/danger.tokens.json": JSON.stringify(
        {
          color: {
            red: { 500: { $value: "#DC2626", $type: "color", $description: "Danger red 500" } },
          },
        },
        null,
        2,
      ),
      "docs/principles/02-consistency.md": `---
id: principle:consistency
type: principle
title: Consistency
summary: Same problem, same solution.
tags: [principle]
---

# Consistency

Reuse before reinvent.
`,
    });

    const r = await manager.refresh();
    expect(r.changed).toBe(true);

    const after = manager.current();
    expect(after.gitSha).not.toBe(shaBefore);
    expect(after.version).not.toBe(versionBefore);
    expect(after.entities.has("token:color.red.500")).toBe(true);
    expect(after.entities.has("principle:consistency")).toBe(true);
  }, 30_000);

  it("two concurrent refresh() calls do not double-rebuild (the #refreshing guard)", async () => {
    // Push a third commit so the refresh has real work to do.
    await commitAndPush("docs: add a convention to force a rebuild", {
      "docs/conventions/01-naming.md": `---
id: convention:naming
type: convention
title: Naming
summary: Use sentence case for labels.
tags: [convention]
---

# Naming

Sentence case for labels; Title Case for navigation.
`,
    });

    // Fire the two refresh() calls without awaiting either, so the second
    // observes the first's #refreshing flag and short-circuits.
    const [a, b] = await Promise.all([manager.refresh(), manager.refresh()]);

    // Exactly one call should report changed=true; the other returns the
    // current version with changed=false. We do not constrain which is which
    // because it's a race — but invariant must hold.
    const changedCount = [a.changed, b.changed].filter(Boolean).length;
    expect(changedCount).toBe(1);

    const after = manager.current();
    expect(after.entities.has("convention:naming")).toBe(true);
  }, 30_000);

  it("checkout stays shallow after multiple refreshes (--depth 1 contract holds)", async () => {
    // After all the prior tests' commits + refreshes, the local checkout
    // should still report `git rev-list --count HEAD` no greater than the
    // depth boundary that git enforces on shallow clones across fetches.
    // If this ever climbs into the dozens, the `--depth 1` clone optimization
    // has been silently undone (e.g. someone removed `--depth 1` from the
    // clone or git's default fetch-shallow behavior changed).
    const entries = await fs.readdir(cacheDir);
    const checkoutPath = path.join(cacheDir, entries[0] ?? "");
    const checkoutGit = simpleGit(checkoutPath);
    const count = Number((await checkoutGit.raw(["rev-list", "--count", "HEAD"])).trim());
    // Soft cap: 5 commits' worth of history is plenty of headroom while still
    // catching unbounded-history regressions. Real shallow behavior keeps this
    // close to 1.
    expect(count).toBeLessThanOrEqual(5);
    const shallowFileExists = await fs
      .stat(path.join(checkoutPath, ".git", "shallow"))
      .then(() => true)
      .catch(() => false);
    expect(shallowFileExists).toBe(true);
  });
});
