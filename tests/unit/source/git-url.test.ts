import { describe, expect, it } from "vitest";
import { deriveRepoSlug, embedTokenIfHttps, redact } from "../../../src/source/git.js";

describe("embedTokenIfHttps", () => {
  it("embeds a PAT as basic auth on https URLs", () => {
    const out = embedTokenIfHttps("https://github.com/acme/design-system.git", "ghp_secret_value");
    const u = new URL(out);
    expect(u.protocol).toBe("https:");
    expect(u.username).toBe("x-access-token");
    expect(u.password).toBe("ghp_secret_value");
    expect(u.hostname).toBe("github.com");
    expect(u.pathname).toBe("/acme/design-system.git");
  });

  it("does not embed a PAT on plain http URLs", () => {
    expect(embedTokenIfHttps("http://internal-git.local/x.git", "tok")).toBe(
      "http://internal-git.local/x.git",
    );
  });

  it("returns the original URL unchanged when no token is supplied", () => {
    expect(embedTokenIfHttps("https://github.com/acme/design-system.git", undefined)).toBe(
      "https://github.com/acme/design-system.git",
    );
  });

  it("passes ssh-shorthand URLs through unchanged (cannot embed token)", () => {
    expect(embedTokenIfHttps("git@github.com:acme/design-system.git", "ghp_x")).toBe(
      "git@github.com:acme/design-system.git",
    );
  });

  it("passes ssh:// URLs through unchanged (relies on key auth)", () => {
    expect(embedTokenIfHttps("ssh://git@github.com/acme/x.git", "ghp_x")).toBe(
      "ssh://git@github.com/acme/x.git",
    );
  });

  it("passes file:// URLs through unchanged (no remote auth needed)", () => {
    expect(embedTokenIfHttps("file:///tmp/upstream.git", "ghp_x")).toBe("file:///tmp/upstream.git");
  });

  it("returns the input unchanged when URL parsing fails", () => {
    expect(embedTokenIfHttps("not a real url", "tok")).toBe("not a real url");
  });
});

describe("redact", () => {
  it("strips username + password from https URLs", () => {
    const r = redact("https://x-access-token:ghp_secret@github.com/acme/x.git");
    expect(r).not.toContain("ghp_secret");
    expect(r).not.toContain("x-access-token");
    expect(r).toContain("github.com/acme/x.git");
  });

  it("returns plain URLs unchanged", () => {
    const r = redact("https://github.com/acme/x.git");
    expect(r).toBe("https://github.com/acme/x.git");
  });

  it("does not throw on non-URL input (passes through)", () => {
    expect(redact("git@github.com:acme/x.git")).toBe("git@github.com:acme/x.git");
  });
});

describe("deriveRepoSlug", () => {
  it("derives a stable slug from an https URL", () => {
    expect(deriveRepoSlug("https://github.com/acme/design-system.git")).toBe("acme__design-system");
  });

  it("derives a stable slug from an ssh-shorthand URL", () => {
    expect(deriveRepoSlug("git@github.com:acme/design-system.git")).toBe("acme__design-system");
  });

  it("strips the trailing .git", () => {
    expect(deriveRepoSlug("https://example.com/owner/repo.git")).toBe("owner__repo");
    expect(deriveRepoSlug("https://example.com/owner/repo")).toBe("owner__repo");
  });

  it("escapes characters that are unsafe for filesystem paths", () => {
    const slug = deriveRepoSlug("https://example.com/some/path/with spaces.git");
    expect(slug).not.toContain(" ");
    expect(slug).not.toContain("/");
    expect(slug.length).toBeGreaterThan(0);
  });

  it("falls back to 'repo' when the URL has no segments", () => {
    expect(deriveRepoSlug("/")).toBe("repo");
  });

  it("falls back to 'repo' for an empty string", () => {
    expect(deriveRepoSlug("")).toBe("repo");
  });

  it("returns a single-segment slug for domain-only URLs", () => {
    // No path → only the host segment is left. The slug is whatever .slice(-2)
    // produces from a 1-segment array (a single element); it must still be a
    // safe filesystem name.
    const slug = deriveRepoSlug("https://github.com");
    expect(slug.length).toBeGreaterThan(0);
    expect(slug).not.toMatch(/[/:]/);
  });
});
