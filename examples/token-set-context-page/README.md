# Token Set Context Trial

This static page was generated from a local `tokens (2).json` file.

The source file uses Token Studio token sets such as `light/color`, `dark/color`, `breakpoints/desktop`, `breakpoints/tablet`, and `breakpoints/mobile`. Those names are valid token-source paths, but `/` cannot be emitted directly inside CSS custom property names. The MCP now formats them with a shared sanitizer:

- `token:light/color.color.action.primary.disabled` -> `var(--light_u002f_color-color-action-primary-disabled)`
- `token:dark/color.color.background.default` -> `var(--dark_u002f_color-color-background-default)`
- `token:breakpoints/mobile.spacing.gutter` -> `var(--breakpoints_u002f_mobile-spacing-gutter)`

## What This Proves

- The real file loads as `191` token entities.
- Unqualified aliases such as `{color.disabled}` resolve against the current token set when both `light/color.color.disabled` and `dark/color.color.disabled` exist.
- `resolve_token` and `validate_ui` agree on the same CSS variable names for token-set paths containing `/`.
- Both stdio and Streamable HTTP MCP transports were smoke-tested with this file.

## What It Does Not Prove

This token file is token-only. It does not include component contracts, pattern contracts, voice rules, or accessibility-specific design guidance, so enterprise composition validation still depends on adding those handoff artifacts beside the tokens.
