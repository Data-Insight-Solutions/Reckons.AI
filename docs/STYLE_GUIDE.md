# Reckons.AI Style Guide

## Brand Identity

**Product:** Reckons.AI — a personal knowledge base powered by RDF triples and AI-assisted analysis.

**Mascot:** Shelly the turtle — a configurable companion that lives on the graph and assists with KB management.

**Tone:** Technical but approachable. Calm, focused, confident. Avoids being flashy or loud.

---

## Color Palette

All colors are defined as CSS custom properties in `src/lib/styles/global.css`.

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg` | `#0a0f14` | Page background (deep ocean) |
| `--surface` | `#131a24` | Card/panel backgrounds |
| `--surface-2` | `#1a2433` | Elevated surfaces, inputs |
| `--surface-3` | `#233040` | Hover states on surfaces |
| `--line` | `#2a3a4d` | Borders, dividers |
| `--ink` | `#e8f0f5` | Primary text |
| `--ink-2` | `#b8c5d4` | Secondary text |
| `--muted` | `#7a8a9d` | Tertiary/labels |
| `--muted-2` | `#5a6a7d` | Quaternary/disabled |
| `--accent` | `#1a9b8e` | Primary action (teal) |
| `--accent-soft` | `#1a9b8e22` | Accent backgrounds |
| `--data` | `#6b4399` | Secondary (deep purple) |
| `--data-soft` | `#6b439922` | Data backgrounds |
| `--danger` | `#d4726d` | Errors, deletions, conflicts |
| `--ok` | `#6ab68a` | Success, confirmed, in-KB |

---

## Typography

Three font stacks, each with a clear role:

| Token | Font | Usage |
|-------|------|-------|
| `--font-display` | Bespoke Stencil | Page headings (h1, h2, h3). Variable font, self-hosted from Fontshare. Bold weight for impact. |
| `--font-body` | Supreme | Body text, descriptions, paragraphs. Default for the page. Variable font, self-hosted from Fontshare. |
| `--font-mono` | Supreme | Labels, badges, kickers, data values, navigation items. Same as body for visual consistency. |

Fonts are self-hosted in `static/fonts/` (woff2 + woff). No external font requests — fully offline-capable.

### Heading hierarchy

```css
h1: font-size: clamp(2.2rem, 6vw, 3.6rem); font-weight: 700; --font-display
h2: font-size: clamp(1.5rem, 4vw, 2.1rem); font-weight: 700; --font-display
h3: font-size: 1.15rem; --font-display
```

### Section headers in settings/panels

Use this consistent pattern for ALL section headings within settings pages:

```css
.settings-section h2 {
  font-family: var(--font-mono);   /* NOT --font-display */
  font-size: 0.85rem;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0 0 1.25rem;
}
```

### Page kickers (subtitle above h1)

```css
.kicker {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.2em;
  margin: 0 0 0.5rem;
}
```

---

## Spacing & Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--rad` | 14px | Cards, large panels |
| `--rad-sm` | 8px | Inputs, small panels, buttons |
| `--rad-lg` | 22px | Modals, full-page overlays |

Pill buttons (tabs, badges, chips): `border-radius: 999px`

---

## Component Patterns

### Cards

```css
.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--rad);
  padding: 1.25rem;
  box-shadow: var(--shadow-1);
}
```

### Buttons

- **Default:** transparent bg, `--line` border, `--ink` text
- **Primary:** `--accent` bg, dark text, `--accent` border
- **Ghost:** transparent border (text-only)
- **Danger:** `--danger` text, transparent border until hover

### Tabs / Pill navigation

```css
.tabs button {
  padding: 0.45rem 0.95rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  text-transform: lowercase;
  letter-spacing: 0.05em;
  border-radius: 999px;
}
.tabs button.active {
  background: var(--accent);
  color: #0a0a0b;
  border-color: var(--accent);
}
```

### Badges

```css
.badge {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
}
```

### Form inputs

```css
input, textarea {
  background: var(--surface);
  border: 1px solid var(--line);
  padding: 0.85rem 1rem;
  border-radius: var(--rad-sm);
  font-family: var(--font-body);
}
input:focus {
  border-color: var(--accent);
  background: var(--surface-2);
}
```

---

## Navigation (NavBar)

- Fixed bottom-center, pill-shaped container
- Backdrop blur (18px) with semi-transparent dark bg
- Each item: glyph (mono) + label (mono uppercase 0.6rem)
- Active state: `--accent` color + `--accent-soft` background
- Pending badge: absolute-positioned count pill

---

## Settings Pages

All settings pages share:

1. **Header:** kicker + h1 + settings-nav (horizontal link tabs)
2. **Nav links:** `--font-mono`, 0.78rem, pill buttons with `--rad-sm`
3. **Sections:** `.settings-section` cards with h2 in mono uppercase accent
4. **Groups:** `.setting-group` with label, control, hint pattern
5. **Hints:** 0.75rem `--muted` text below controls

---

## Z-Index Scale

| Layer | z-index |
|-------|---------|
| Node labels (graph) | 10 |
| Panels (SnapPanel) | 300 |
| Shelly chat | 350 |
| SearchBar | 390 |
| NavBar | 400 |
| MergeReview overlay | 500 |

---

## Writing Style

- **Labels:** lowercase mono (e.g., "ingest", "review", "upcoming")
- **Descriptions:** sentence case, no period at end for single-line hints
- **Actions:** imperative lowercase (e.g., "import events", "accept all")
- **Status text:** mono font, lowercase with ellipsis for loading (e.g., "importing...")

---

## Do / Don't

**Do:**
- Use CSS variables for all colors — never hardcode hex in components
- Use `--font-mono` for all interactive labels, navigation, data
- Use `--font-display` only for page headings (h1-h3)
- Use `--font-body` for paragraphs and descriptions
- Keep section headers in settings consistent (mono, uppercase, accent color)

**Don't:**
- Mix font stacks within the same element type across pages
- Use `--font-display` for small labels or section headings inside panels
- Hardcode border-radius values — use `--rad`, `--rad-sm`, `--rad-lg`
- Create new color values without adding them to the `:root` block
