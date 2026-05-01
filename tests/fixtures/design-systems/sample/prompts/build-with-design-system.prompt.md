---
name: build_with_design_system
description: Build a UI component using the design system's tokens, principles, and patterns.
arguments:
  - name: component_type
    required: true
    description: What you are building (e.g. "settings page", "delete confirmation")
  - name: requirements
    required: false
    description: Specific requirements or constraints
---

You are building a {{component_type}} for our product.

Before generating any code:

1. Call `describe_schema` to learn what content types exist.
2. Call `search_design_system` with terms relevant to your task to find applicable
   patterns, principles, and components.
3. Call `get_entity` to fetch full content for the top hits.
4. Call `resolve_token` for any concrete values (colors, spacing, typography) you
   need — never hard-code hex codes or pixel values.

Constraints:
- Use only tokens from this system. No raw hex, rgb, px values.
- Follow the patterns. If a confirmation-dialog pattern exists, use it for
  destructive actions instead of inventing a new modal.
- Match the voice and tone in voice:default for all copy.

Requirements: {{requirements}}
