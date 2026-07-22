# Boubyan Dental Center — Design System MASTER
**Version:** 5.0 | **Theme:** Slate Pro Dark/Light | **Stack:** Vanilla HTML/CSS/JS | **RTL:** Arabic-first + EN toggle

---

## 1. Token Architecture (Three-Layer)

```
Primitive  →  Semantic  →  Component
(raw values)   (purpose)    (per-component)
```

---

## 2. Primitive Tokens

### Color Scale

| Token | Value | Usage |
|-------|-------|-------|
| `--slate-950` | `#0a0c10` | Deepest background |
| `--slate-900` | `#0f1117` | App background (dark) |
| `--slate-800` | `#141720` | Secondary surface |
| `--slate-700` | `#1a1f2e` | Tertiary surface |
| `--slate-600` | `#202536` | Surface hover |
| `--slate-500` | `#272d3f` | Surface active |
| `--slate-400` | `#323850` | Border active |
| `--slate-300` | `#48526a` | Muted border |
| `--slate-200` | `#6b7a96` | Tertiary text |
| `--slate-100` | `#94a3b8` | Secondary text |
| `--slate-50`  | `#cbd5e1` | Primary text (light) |

| Token | Value | Meaning |
|-------|-------|---------|
| `--blue-600` | `#2563eb` | Interactive dark |
| `--blue-500` | `#3b82f6` | Interactive primary |
| `--blue-400` | `#60a5fa` | Interactive light |
| `--blue-300` | `#93c5fd` | Interactive muted |
| `--emerald-600` | `#059669` | Income dark |
| `--emerald-500` | `#10b981` | Income primary |
| `--emerald-400` | `#34d399` | Income light |
| `--amber-600` | `#d97706` | Warning dark |
| `--amber-500` | `#f59e0b` | Warning primary |
| `--amber-400` | `#fbbf24` | Warning light |
| `--rose-600` | `#dc2626` | Danger dark |
| `--rose-500` | `#ef4444` | Danger primary |
| `--rose-400` | `#f87171` | Danger light |
| `--violet-500` | `#7c3aed` | AI features |
| `--violet-400` | `#8b5cf6` | AI light |

### Spacing Scale (4px base)

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | `4px` | Micro gap |
| `--space-2` | `8px` | Icon gap, small padding |
| `--space-3` | `12px` | Button padding-y |
| `--space-4` | `16px` | Component padding |
| `--space-5` | `20px` | Card padding |
| `--space-6` | `24px` | Section padding |
| `--space-7` | `28px` | Content padding |
| `--space-8` | `32px` | Large section |

### Typography Scale

| Token | Size | Weight | Usage |
|-------|------|--------|-------|
| `--text-xs` | `9px` | 600–700 | Labels, uppercase |
| `--text-sm` | `10px` | 600–700 | Table headers, badges |
| `--text-base` | `11px` | 400 | Body text |
| `--text-md` | `12px` | 400–600 | UI text, buttons |
| `--text-lg` | `13px` | 600–700 | Card titles |
| `--text-xl` | `14px` | 700 | Section subheadings |
| `--text-2xl` | `15px` | 700 | Modal titles |
| `--text-3xl` | `18px` | 700 | Page titles |
| `--text-kpi` | `24px` | 700 | KPI values (mono) |

### Border Radius Scale

| Token | Value | Usage |
|-------|-------|-------|
| `--r-xs` | `4px` | Tiny elements |
| `--r-sm` | `6px` | Buttons, badges |
| `--r-md` | `10px` | Cards, inputs |
| `--r-lg` | `14px` | KPI cards, tables |
| `--r-xl` | `18px` | Modals, upload zones |
| `--r-full` | `9999px` | Pills, toggles |

### Animation Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--t-fast` | `80ms ease` | Micro feedback |
| `--t-base` | `150ms ease` | Standard transitions |
| `--t-slow` | `260ms ease` | Page reveals |
| Scroll reveal | `420ms cubic-bezier(.4,0,.2,1)` | IntersectionObserver |
| Tab fade | `240ms cubic-bezier(.4,0,.2,1)` | Tab switch |
| KPI counter | `1100ms easeOutQuart` | Number animation |

---

## 3. Semantic Tokens

### Dark Theme (default)

| Token | Primitive Ref | Purpose |
|-------|--------------|---------|
| `--bg` | `#0f1117` | App background |
| `--surface` | `#161b27` | Card/panel surface |
| `--surface2` | `#1c2233` | Input/nested surface |
| `--surface3` | `#222840` | Hover state surface |
| `--surfaceHov` | `#28304a` | Active hover |
| `--border` | `#252d42` | Subtle separator |
| `--borderAct` | `#3a4560` | Active border |
| `--borderFoc` | `#3b82f6` | Focus ring |
| `--text` | `#e2e8f0` | Primary text |
| `--text2` | `#94a3b8` | Secondary text |
| `--text3` | `#4b5a72` | Tertiary/muted text |
| `--accent` | `--blue-500` | Primary interactive |
| `--accentDark` | `--blue-600` | Primary interactive dark |
| `--accentLight` | `--blue-300` | Primary interactive light |
| `--accentGlow` | `rgba(59,130,246,.12)` | Glow effect |
| `--accent2` | `--emerald-500` | Income / success |
| `--accent2Dark` | `--emerald-600` | Income dark |
| `--accent2Glow` | `rgba(16,185,129,.12)` | Income glow |
| `--accent3` | `--amber-500` | Commission / warning |
| `--accent3Dark` | `--amber-600` | Commission dark |
| `--accent3Glow` | `rgba(245,158,11,.12)` | Commission glow |
| `--success` | `#10b981` | Success state |
| `--warning` | `#f59e0b` | Warning state |
| `--danger` | `#ef4444` | Error/danger state |
| `--info` | `#60a5fa` | Info state |

### Light Theme (`.light` class on `<html>`)

| Token | Value | Delta from dark |
|-------|-------|-----------------|
| `--bg` | `#f4f6fb` | Warm slate-50 |
| `--surface` | `#ffffff` | Pure white cards |
| `--surface2` | `#eef2f8` | Soft blue-grey |
| `--surface3` | `#e4e9f2` | Hover surface |
| `--border` | `#dde3ef` | Light separator |
| `--text` | `#0d1526` | Near-black |
| `--text2` | `#3d5068` | Dark slate |
| `--text3` | `#8898aa` | Muted slate |

**KPI value overrides (light mode):**
| Card type | Color | Reason |
|-----------|-------|--------|
| `.kc.bl` (revenue) | `#1d4ed8` | Higher contrast blue |
| `.kc.gr` (net) | `#047857` | Higher contrast emerald |
| `.kc.or/.ye` (commissions) | `#b45309` | Higher contrast amber |
| `.kc.re` (insurance) | `#b91c1c` | Higher contrast red |

---

## 4. Component Tokens

### KPI Cards

| Variant | Border | Glow | Top bar |
|---------|--------|------|---------|
| `.kc.bl` — Revenue | `rgba(79,142,247,.22)` | `rgba(59,130,246,.22)` | `accent → accentLight` |
| `.kc.gr` — Net | `rgba(45,212,191,.18)` | `rgba(16,185,129,.22)` | `accent2 → teal` |
| `.kc.re` — Insurance | `rgba(248,113,113,.18)` | `rgba(239,68,68,.22)` | `danger → rose` |
| `.kc.or` — Commission | `rgba(251,191,36,.18)` | `rgba(245,158,11,.22)` | `accent3 → amber` |
| `.kc.ye` — Pending | `rgba(251,191,36,.18)` | `rgba(245,158,11,.22)` | `warning → gold` |

**States:**
- Default: `border` subtle, `shadow-xs`
- Hover: `translateY(-4px)` + color glow shadow + brighter border
- Refresh: `kpiPulse` animation (600ms)
- Loading: `.skeleton-kpi` shimmer overlay

### Buttons

| Variant | Class | Background | Text |
|---------|-------|------------|------|
| Primary | `.bp` | `accent → accentDark` gradient | `#fff` |
| Success | `.bs` | `accent2 → accent2Dark` gradient | `#03211e` |
| Danger | `.bd` | `rgba(danger, .10)` | `danger` |
| Warning | `.bw` | `rgba(warning, .10)` | `warning` |
| Export | `.bex` | `rgba(accent, .08)` | `accentLight` |
| Small | `+.bsm` | Inherits variant | Smaller padding |

**States:**
- Hover: `translateY(-1px)` + stronger shadow
- Active: `translateY(1px)` always
- Loading: spinner overlay + `pointer-events:none`
- Focus: `2px solid accent` ring + `2px offset`

**Ripple effect:** Delegated click listener creates `.ripple-effect` span (scale 0→4, 550ms, rgba white .25)

### Badges

| Class | Color | Background |
|-------|-------|------------|
| `.bb` | `accentLight` | `rgba(accent, .12)` |
| `.bg` | `accent2` | `rgba(accent2, .12)` |
| `.bo` | `accent3` | `rgba(accent3, .12)` |
| `.br` | `danger` | `rgba(danger, .12)` |
| `.by` | `warning` | `rgba(warning, .10)` |

### Tables

- Header: `surface2` bg, `text3` uppercase labels, 10px/700w
- Row hover: `rgba(accent, .05)`
- Even rows: `rgba(14,28,58,.35)` (dark) / `rgba(238,242,248,.55)` (light)
- Category indicator: 2.5px left border in category color
- Sticky header: `position:sticky; top:0; z-index:2`
- Numbers: `.num` — IBM Plex Mono, `font-variant-numeric: tabular-nums`

### Forms / Inputs

| Element | Token | Value |
|---------|-------|-------|
| Background | `--surface2` | Nested surface |
| Border | `--border` | Subtle |
| Border focus | `--borderFoc` | Blue |
| Focus ring | `box-shadow` | `0 0 0 3px rgba(accent,.15)` |
| Height | min | `44px` (touch target) |
| Font | IBM Plex Sans Arabic | RTL-first |

### Modals

- Backdrop: `rgba(2,6,18,.82)` + `blur(8px)`
- Box: `surface` bg + `borderAct` border + `shadow-lg`
- Width: `360px` max `92vw`
- Radius: `--r-xl`
- Animation: scale+fade from trigger source

---

## 5. Typography System

### Font Stack

| Role | Font | Fallback |
|------|------|---------|
| UI (Arabic primary) | `IBM Plex Sans Arabic` | sans-serif |
| UI (English) | `Inter` | sans-serif |
| Monospace / Numbers | `IBM Plex Mono` | monospace |

### Weights Used

| Weight | Usage |
|--------|-------|
| 300 | Light labels (rare) |
| 400 | Body, secondary text |
| 500 | Navigation, medium emphasis |
| 600 | Buttons, table headers |
| 700 | Page titles, KPI values, headings |

### Direction Rules

| Language | `dir` | Font | Nav indicator |
|----------|-------|------|---------------|
| Arabic (default) | `rtl` | IBM Plex Sans Arabic | Right edge |
| English | `ltr` | Inter | Left edge |

---

## 6. Animation System

### Principles (ui-ux-pro-max compliant)
- Duration: 150–300ms micro / 400–550ms macro
- Easing: `cubic-bezier(.4,0,.2,1)` entering, `ease` exiting
- Never animate `width/height` — use `transform/opacity` only
- Always respect `prefers-reduced-motion` (global override at .01ms)
- Animations are interruptible

### Named Animations

| Name | Duration | Trigger | Effect |
|------|----------|---------|--------|
| `tabFadeIn` | 240ms | Tab switch | `opacity 0→1 + translateY 14→0` |
| `toastIn` | 280ms | Toast show | `translateX -20→0 + fade` (spring) |
| `toastOut` | 220ms | Toast dismiss | `translateX 0→-20 + fade` |
| `kpiPulse` | 600ms | Data refresh | Outline glow pulse |
| `numFlash` | 1200ms | Counter end | Color flash accent→inherit |
| `glowPulse` | 600ms | Save action | Green glow pulse |
| `shimmer` | 1600ms ∞ | Skeleton load | Background slide |
| `rowFadeIn` | 180ms | Table row add | `translateX 6→0 + fade` |
| `ripple` | 550ms | Button click | Scale 0→4 + fade |
| `revealUp` | 420ms | Scroll reveal | `translateY 18→0 + fade` |
| `pulse` | 2500ms ∞ | Status dot | Opacity pulse |

### Scroll Reveal (IntersectionObserver)
- Threshold: `0.08`
- Root margin: `0px 0px -30px 0px`
- Stagger: `50ms` per item
- Targets: `.tw, .kc, .dc, .ins-box`

---

## 7. Layout System

### App Shell

```
┌─────────────────────────────────────────────┐
│  header (sticky, 58px, blur backdrop)       │
├──────────────┬──────────────────────────────┤
│  sidebar     │  content-wrap                │
│  224px       │  flex:1, padding 0 28px      │
│  sticky 58px │  z-index:1                   │
│  collapsed:  │                              │
│  60px        │                              │
└──────────────┴──────────────────────────────┘
```

### Sidebar States

| State | Width | Labels | Icons |
|-------|-------|--------|-------|
| Expanded | `224px` | Visible | + text |
| Collapsed | `60px` | Hidden | Center |

### Z-Index Scale

| Layer | Value | Elements |
|-------|-------|----------|
| Base | 0 | Normal flow |
| Content | 1 | app-body, content-wrap |
| Header | 100 | `<header>` |
| Modal | 200 | `.modal` |
| Toast | 8000 | `#toast-region` |
| Progress | 9999 | `#nprogress` |
| Skip link | 9999 | `.skip-link` |

---

## 8. Accessibility (WCAG AA)

| Requirement | Implementation |
|-------------|----------------|
| Color contrast | `text` on `bg` ≥ 4.5:1 ✅ |
| Focus rings | `2px solid accent + 3px offset` on all interactive |
| Touch targets | `min-height: 44px` on `.btn, .nav-item, .bex` |
| Reduced motion | `@media (prefers-reduced-motion)` → `.01ms` |
| Screen readers | `.sr-only` utility + `aria-live="polite"` on toasts |
| Skip link | `.skip-link` → `#main-content` |
| Keyboard nav | Tab order = visual order (RTL aware) |
| Form labels | `.flbl` + `for` attribute on all inputs |
| Icon buttons | `aria-label` required on icon-only controls |

---

## 9. Component Color Semantics (Accounting-specific)

| Color | Semantic meaning | Usage |
|-------|-----------------|-------|
| 🔵 Blue | Interactive / Revenue | CTA buttons, revenue KPI, total amounts |
| 🟢 Emerald | Positive / Net income | Net revenue, success states, paid status |
| 🟡 Amber | Commission / Warning | Commission KPIs, pending states, warnings |
| 🔴 Red | Deductions / Danger | Insurance share, danger alerts, delete |
| 🟣 Violet | AI features | AI chat, smart analysis, automation |
| ⚫ Slate | Neutral / Structure | Backgrounds, borders, text hierarchy |

**Never use color alone** — always pair with text label or icon for status communication.

---

## 10. Design Tokens JSON (W3C DTCG format)

```json
{
  "color": {
    "primitive": {
      "blue-500": { "$value": "#3b82f6", "$type": "color" },
      "emerald-500": { "$value": "#10b981", "$type": "color" },
      "amber-500": { "$value": "#f59e0b", "$type": "color" },
      "rose-500": { "$value": "#ef4444", "$type": "color" }
    },
    "semantic": {
      "accent": { "$value": "{color.primitive.blue-500}", "$type": "color" },
      "success": { "$value": "{color.primitive.emerald-500}", "$type": "color" },
      "warning": { "$value": "{color.primitive.amber-500}", "$type": "color" },
      "danger": { "$value": "{color.primitive.rose-500}", "$type": "color" }
    }
  },
  "typography": {
    "font-arabic": { "$value": "IBM Plex Sans Arabic", "$type": "fontFamily" },
    "font-mono": { "$value": "IBM Plex Mono", "$type": "fontFamily" },
    "font-english": { "$value": "Inter", "$type": "fontFamily" }
  },
  "radius": {
    "sm": { "$value": "6px", "$type": "borderRadius" },
    "md": { "$value": "10px", "$type": "borderRadius" },
    "lg": { "$value": "14px", "$type": "borderRadius" },
    "xl": { "$value": "18px", "$type": "borderRadius" }
  },
  "animation": {
    "duration-fast": { "$value": "80ms", "$type": "duration" },
    "duration-base": { "$value": "150ms", "$type": "duration" },
    "duration-slow": { "$value": "260ms", "$type": "duration" }
  }
}
```

---

## 11. Anti-Patterns (DO NOT)

| Anti-pattern | Correct approach |
|-------------|-----------------|
| Raw hex in components | Use `var(--accent)` semantic token |
| Emojis as structural icons | Use Unicode symbols or SVG |
| Animating `width/height` | Use `transform: scale()` |
| `overflow:hidden` on scrollable | Use `overflow-x: auto` |
| `100vh` on mobile | Use `min-h-dvh` or `calc(100vh - 58px)` |
| Color-only status | Always pair color with text/icon |
| Missing `aria-label` on icon buttons | Add `aria-label="..."` |
| Hardcoded px spacing | Use spacing scale multiples of 4 |
| Mixing font styles (emoji + mono) | Single consistent symbol style per layer |

---

## 12. Page-Specific Overrides

See `design-system/pages/` for page-level deviations:

| Page | File | Deviations |
|------|------|------------|
| Dashboard | `pages/dashboard.md` | KPI grid, chart colors, scroll reveal |
| Doctors | `pages/doctors.md` | Card avatar colors, commission display |
| Settings | `pages/settings.md` | Toggle styles, config tabs |

---

*Generated by ckmdesign-system skill — Boubyan v5.0 | 2026-06-16*
