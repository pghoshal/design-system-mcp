---
id: convention:getdesign
type: convention
title: Community Getdesign
summary: Community-published design guidance for UX-to-dev handoff.
tags:
  - community
  - handoff
related:
  - component:button
tokens:
  color:
    community:
      accent:
        value: "#7C3AED"
        type: color
        description: Community Markdown accent color.
      accentHover:
        value: "{color.community.accent}"
        type: color
---

# Community Handoff

Use component:button for primary actions and token:color.action.primary for primary color.

Markdown token tables in community docs are guidance only. Deterministic token resolution still comes from Style Dictionary token JSON.

| Token | Value | Type |
| --- | --- | --- |
| color.prose.tableOnly | #ABCDEF | color |
