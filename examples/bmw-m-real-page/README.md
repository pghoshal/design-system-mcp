# BMW M Real-World MCP Page Trial

This static page was generated from a local `DESIGN-bmw-m.md` file during a real Markdown-only design-system compatibility test.

- `tokens.css` mirrors the resolved BMW M token values.
- `styles.css` consumes those tokens through CSS custom properties.
- `index.html` contains the one-page frontend.

Open `index.html` directly in a browser or serve this directory with any static file server.

## What This Proves

The source design system is a community-style Markdown file with YAML frontmatter sections such as `colors`, `spacing`, `rounded`, `typography`, and `components`. The MCP bundle now normalizes those sections into Style Dictionary input, so agents can call `resolve_token` and receive deterministic token values instead of treating the whole file as prose only.

The page was checked through the MCP validation path:

```bash
SRC=$(mktemp -d /tmp/bmw-m-ds-XXXXXX)
cp /path/to/DESIGN-bmw-m.md "$SRC/DESIGN.md"
pnpm validate -- --source "$SRC" --language html --format json examples/bmw-m-real-page/index.html
```

Expected result:

```json
{
  "ok": true,
  "counts": {
    "error": 0,
    "warning": 0,
    "info": 0
  }
}
```

## What It Does Not Prove

This Markdown file does not define rich component entities, pattern contracts, or composition evidence. That means token resolution, copy checks, accessibility checks, semantic token checks, search, and community coverage work; strict enterprise composition gates still need structured `components/`, `patterns/`, and related metadata.
