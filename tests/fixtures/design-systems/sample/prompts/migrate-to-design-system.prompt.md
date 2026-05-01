---
name: migrate_to_design_system
description: Migrate legacy UI code to this design system.
arguments:
  - name: legacy_context
    required: true
    description: Legacy UI code or migration summary
---

Migrate the legacy UI to this design system.

Required loop:
1. Identify raw colors, spacing, unsupported components, and off-voice copy.
2. Call `resolve_token` for every replacement token.
3. Call `recommend_composition` for the target UI intent.
4. Call `validate_composition` before coding.
5. Call `validate_ui` after coding and repair all error-severity findings.

Legacy context: {{legacy_context}}
