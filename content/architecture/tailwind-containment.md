---
title: "Tailwind-Without-Preflight Containment"
slug: "tailwind-containment"
order: 1042
section: "Architecture"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "shadcn-svelte components are introduced on Tailwind v4 with Tailwind's CSS reset (preflight) disabled."
generated: "docs-kb"
related:
  - "style-conventions"
---

# Tailwind-Without-Preflight Containment

*Concept*

shadcn-svelte components are introduced on Tailwind v4 with Tailwind's CSS reset (preflight) disabled. Preflight would rewrite base element styles (margins, headings, form controls) across the whole app and collide with the existing hand-rolled Liquid CSS. Disabling it lets Tailwind utility classes and the new components layer on top of, rather than replace, the current design language. Component-level tokens map onto the existing CSS variables (--accent, --surface, --rad, etc.) documented in arch:StyleConventions, so new shadcn components pick up the same theme automatically.

## Related

**Related**

- [Style Conventions](../architecture/style-conventions)
