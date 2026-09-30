# Design System

## Design Thesis

The public showcase treats real projects as nodes in a running laboratory topology. The visual system uses an ink-black field, mineral-white typography, a single signal-orange accent, real project media, and restrained engineering metadata. It must prove work before making claims.

This visual world belongs to the public showcase. The member and management systems remain task-first and must not inherit the showcase's giant type, particles, or experimental composition.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--ink` | `#11110f` | Page and dark control ground |
| `--ink-raised` | `#181815` | Raised media and result surfaces |
| `--paper` | `#f0eee7` | Primary text and light surfaces |
| `--paper-dim` | `#b7b4ab` | Supporting copy and metadata |
| `--line` | `rgba(240, 238, 231, .16)` | Structural dividers |
| `--line-strong` | `rgba(240, 238, 231, .34)` | Interactive boundaries |
| `--signal` | `#ff633e` | Primary action, active node, focus and status |

Signal orange is scarce state language. Do not add competing accent colors or gradient text.

## Typography

- Display: `Bahnschrift SemiCondensed`, `DIN Alternate`, then the Chinese/system sans fallbacks already declared in `home.css`.
- Body: `Microsoft YaHei`, `PingFang SC`, `Helvetica Neue`, Arial, sans-serif.
- Data: `Cascadia Mono`, `SFMono-Regular`, Consolas, monospace.
- Giant display type is reserved for the hero and section transitions. Body copy stays readable with generous line height. Monospace is only for identifiers, status, filters, and measurements.
- No remote font dependency is required; this preserves the current self-hosted CSP and fast first render.

## Layout

- Desktop content width: `min(1440px, calc(100vw - 64px))`.
- The first viewport uses a 7:5 split: proposition and actions on the left, a live project artifact on the right, and real content totals on the lower edge.
- Project cards use an asymmetric 12-column rhythm. Capability and process sections use 5:7 splits. Achievements use a complete three-column archive rather than a clipped horizontal track.
- Sections use structural lines and negative space rather than generic rounded cards or shadows.
- At `1080px`, navigation collapses and result cards become two columns. At `760px`, primary layouts become one column, project media becomes 4:3, and achievements become a horizontal snap list. At `420px`, hero copy and actions tighten without horizontal overflow.

## Components

- Primary actions use signal orange with ink text. Secondary actions are transparent with a mineral-white boundary. Both invert to paper on hover and move by one pixel on press.
- Project cards always present a still image for a consistent scan. Video records remain available to the CMS but do not play on the showcase homepage.
- Missing or broken project images fall back to an honest CSS topology placeholder, never a fake screenshot.
- Project filters expose visible selected state and `aria-pressed` semantics.
- Achievement cards may map existing projects when no separate achievement records exist, but this fallback must never be counted or described as a competition award.
- Corners remain square. Circles are reserved for nodes, tracks, status and video controls.

## Motion

- The WebGL layer uses local Three.js and represents project nodes, particles, connections and one signal core. It is an enhancement, never the content layer.
- Desktop uses up to 900 particles and 150 links. Mobile uses 180 particles and 30 links, DPR 1, and no antialiasing.
- Particle rendering pauses outside the first-viewport observation area and while the document is hidden. It does not load for reduced-motion or data-saver users.
- CSS motion includes one-time section reveals, a status pulse, project scanning, restrained orbit movement and one technology strip.
- The process section is the focal scroll sequence: a sticky mechanical arm assembles across four real workflow steps using CSS view timelines. Unsupported or reduced-motion environments show the complete static arm.
- Animate transforms and opacity rather than layout dimensions.

## Accessibility

- Core content, navigation, project data and calls to action remain semantic HTML.
- Preserve the skip link, visible focus state, image alternative text, button labels, `aria-live` result regions and keyboard-operable filters.
- `prefers-reduced-motion` removes smooth scrolling, transitions, CSS loops and WebGL.
- `prefers-reduced-transparency` replaces blurred surfaces with opaque ink.
- Canvas, video or image failure must not block reading, joining, contacting or entering the workspace.

## Content Rules

- Use real project names, media, competition records, dates and process evidence.
- Never invent awards, rankings, partners, sponsors, performance figures or member contributions.
- A project description should identify the real problem, core approach and verified result.
- Keep project and achievement IDs stable and unique because they are operational relationships, not visual labels.

## Management Boundary

The management UI remains an operate-mode surface: direct labels, visible validation, preview before commit, explicit progress, recoverable errors and conservative motion. Showcase tokens may appear only as subtle brand continuity; immersive effects must not reduce administrative scanability or speed.
