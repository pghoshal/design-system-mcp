---
id: pattern:confirmation-dialog
type: pattern
title: Confirmation Dialog
summary: Modal pattern for confirming destructive or irreversible actions before they execute.
tags: [pattern, modal, destructive]
related: [principle:clarity]
contract:
  requiredComponents:
    - component:button
  requiredTokens:
    - token:color.action.danger
  requiredPrinciples:
    - principle:clarity
  slots:
    - name: confirm-action
      required: true
      component: component:button
      description: Destructive confirmation action.
  constraints:
    - id: confirmation-specific-copy
      severity: warning
      message: Confirmation copy must name the object and irreversible action.
---

# Confirmation Dialog

Use a confirmation dialog before any **destructive** or **irreversible** action.
Do not use it for ordinary saves, filter changes, or non-destructive selections —
those are friction without benefit.

## Anatomy

- Title: states the action ("Delete project?")
- Body: one sentence on what happens and what cannot be undone
- Two actions: secondary "Cancel" on the left, destructive primary on the right
- Destructive action uses `color.action.danger`
- Closes on `Esc`, on backdrop click, on Cancel, or on confirm

## Voice

Match the voice-and-tone guidance: be specific about what will be deleted,
avoid hedging ("maybe", "might"), and never blame the user.
