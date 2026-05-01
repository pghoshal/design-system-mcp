---
name: repair_design_violations
description: Repair validation findings until generated UI passes the design-system gates.
arguments:
  - name: violations
    required: true
    description: JSON or prose list of validate_ui or validate_composition violations
---

Repair the design-system violations.

Process:
1. Group findings by severity.
2. Apply deterministic `replaceWith` fixes first.
3. For remaining findings, call `get_entity`, `resolve_token`, or `get_usage` for the referenced source entity.
4. Re-run `validate_ui` and `validate_composition`.
5. Stop only when there are no error-severity violations.

Violations: {{violations}}
