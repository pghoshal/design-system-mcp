---
name: review_ui_against_design_system
description: Review generated UI against the design system and validation rules.
arguments:
  - name: code_context
    required: true
    description: The UI code, diff, or file summary to review
---

Review the provided UI against this design system.

Required loop:
1. Call `search_design_system` for relevant components, patterns, tokens, and voice guidance.
2. Call `get_usage` for every component used in the code.
3. Call `validate_ui` on the code.
4. Report every error-severity violation first, with the rule id and repair.

Code context: {{code_context}}
