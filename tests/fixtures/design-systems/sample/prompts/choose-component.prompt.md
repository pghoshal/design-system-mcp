---
name: choose_component
description: Choose the correct design-system component for an implementation intent.
arguments:
  - name: intent
    required: true
    description: The UI intent or interaction to build
---

Choose the design-system component for this intent.

Required evidence:
1. Call `recommend_composition` with the intent.
2. Compare the recommended components with the alternatives.
3. Call `explain_decision` for the selected component.
4. Return the selected component id, rejected alternatives, and source evidence.

Intent: {{intent}}
