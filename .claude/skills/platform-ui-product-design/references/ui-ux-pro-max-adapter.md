# UI/UX Pro Max Adapter for QuantPilot

This reference adapts the public `nextlevelbuilder/ui-ux-pro-max-skill` workflow to QuantPilot. Use it as the design decision layer before implementing platform pages or judging generated financial dashboards.

## Source Workflow

UI/UX Pro Max uses a searchable design system workflow:

1. Classify product type and industry.
2. Pick a page pattern.
3. Pick a UI style.
4. Pick color and typography systems.
5. Apply UX rules by priority.
6. Apply stack-specific implementation rules.
7. Apply chart/data visualization rules.
8. Run a pre-delivery checklist.

QuantPilot should use the same sequence, but with narrower defaults for quant, agent, evaluation, operations, and data-platform pages.

## QuantPilot Default Design System

- Product type: quant SaaS, AI agent workbench, data platform, operations console, financial analytics.
- Page pattern: Real-Time / Operations Landing for home and platform entry pages; Data-Dense Dashboard for consoles and generated reports.
- Style: Data-Dense Dashboard, quiet enterprise SaaS, shadcn-like primitives, compact workbench.
- Palette: neutral surface with blue primary, amber accent, semantic status colors.
- Typography: system font stack by default; use tabular numbers for metrics, prices, timers, run IDs, and table values.
- Effects: row highlighting, clear hover/focus states, sheet/modal transitions, filter transitions, lightweight chart interactions.
- Anti-patterns: ornate visuals, decorative gradients, no filtering, no table alternative for charts, giant hero sections for operational pages.

Suggested token direction:

| Role | Preferred Direction |
| --- | --- |
| Background | `#F8FAFC`, `#F6F7FB`, or existing app surface token |
| Foreground | slate-900 / neutral-900 |
| Primary | QuantPilot brand red where product identity matters; blue for running/info/links |
| Accent | amber for warnings and secondary emphasis |
| Success | emerald |
| Error | red |
| Border | slate-200 / neutral-200 |
| Muted | slate-50 / slate-100 |

Do not copy UI/UX Pro Max suggested Google Font imports into generated pages or platform files unless the project already allows remote fonts. Prefer local/system fonts and existing `globals.css` tokens.

## UX Rule Priority

1. Accessibility: text contrast, keyboard navigation, focus rings, aria labels for icon-only buttons, semantic headings.
2. Touch and interaction: 44px minimum touch targets where practical, 8px spacing between controls, visible async feedback.
3. Performance and stability: reserve space for async content, avoid layout shift, lazy-load heavy visualizations when appropriate.
4. Style consistency: one visual language per page, lucide icons, no emoji icons, no random raw hex values in leaf components.
5. Responsive layout: verify 375px, 768px, 1024px, 1440px; no horizontal scroll unless a data table has an intentional scroll container.
6. Typography and color: 12/14/16/18/24/32 type scale, tabular numbers, semantic colors with text/icons beyond color alone.
7. Animation: 150-300ms, transform/opacity only, meaningful motion, reduced-motion support.
8. Forms and feedback: visible labels, inline errors, submit loading, destructive confirmations, recovery path for errors.
9. Navigation: clear active state, predictable back behavior, URL/deep-linkable top-level pages.
10. Charts and data: legends, labels, tooltips, table alternative, accessible colors, never rely on color alone.

## Platform Page Patterns

- Home: compact command center, recent work, platform links, service health, clear primary creation action.
- Workspaces: paginated grid/table, status chips, last activity, quick actions, empty state with create/import.
- Project detail: chat/workbench first, artifacts second, run/health details in sheet or side panel.
- Evals: left navigation or tabs by module; each module gets its own route/view; cases and sets paginate at 10 unless local constant says otherwise.
- Skills: source tree, version/package status, policy checks, lock/changelog context, searchable lists.
- Operations: health + generation trace as one observability surface; time-ordered timeline and root-cause detail.
- Data platform: data sources, database status, Timescale/Postgres readiness, ingestion jobs, schema bootstrap.
- Strategy platform: strategy catalog, parameter sets, backtest runs, risk controls, benchmark comparisons.
- Settings: model, providers, database, environment, security, feature flags, not generic demo settings.

## Generated Financial Dashboard Patterns

Generated workspace pages should still be built by `dashboard-visualization`, but use this checklist:

- First viewport shows actual financial content: account summary, holdings matrix, K-line, comparison grid, backtest equity, evaluation result, or data quality status.
- Avoid marketing hero, template-name banners, giant slogan text, empty dark cards, and single-hue gradients.
- Every chart has nearby numeric summary and a table/list fallback.
- Candlestick/OHLC pages include volume, visible price/date labels, MA legend, and recent-data table.
- Multi-symbol pages include all requested symbols, comparison matrix, relative-strength chart/table, and per-symbol source status.
- Data quality, missing fields, source freshness, and refresh/retry affordances are visible but not allowed to dominate the hero.
- Use stable chart dimensions and skeletons to avoid layout shift.

## Next.js / shadcn Rules

- Prefer shadcn-style semantic primitives over custom `div role="button"` implementations.
- Use `Button`, `Badge`, `Input`, `Select`, `Sheet`, `AlertDialog`, and local quant primitives before adding new controls.
- Use semantic tables for tabular data; if a custom grid is necessary, keep header/body semantics accessible.
- Reserve space for images, charts, sidebars, drawers, and dynamic panels.
- For heavy charts or inspectors, consider route-level splitting or dynamic import.
- Keep server/client boundaries clean; do not turn entire routes into client components just for one interactive widget.

## Review Questions

Before shipping a UI change, answer these quickly:

- What is the product/page type and why does this layout fit it?
- What is the one primary user action on this screen?
- What real data or workflow appears in the first viewport?
- What happens when data is loading, empty, failed, long, or too large?
- Can keyboard and screen-reader users complete the core action?
- Does the design still work at 375px and 1440px?
- Does every chart or color-coded state have text or structural backup?
