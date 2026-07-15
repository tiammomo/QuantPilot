/**
 * Shared visual language for generated QuantPilot dashboards.
 *
 * Financial workbenches should read as one continuous analytical surface. The
 * selectors deliberately have more specificity than the legacy template CSS so
 * restored and scenario-specific dashboards cannot drift back to floating card
 * grids merely because their older component class names still contain `card`.
 */
export function baseDashboardWorkbenchCss(): string {
  return `
/* ==================== FINANCIAL WORKBENCH CANVAS ==================== */

.dashboard-shell[data-visual-language="financial-workbench"] {
  width: min(1440px, 100vw);
  margin: 0 auto;
  padding: 0 28px 48px;
  border-inline: 1px solid var(--line);
  background: var(--panel);
  --shadow-sm: none;
  --shadow-md: none;
}

.dashboard-shell[data-visual-language="financial-workbench"] .hero-panel {
  margin: 0;
  padding: 18px 0 16px;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.dashboard-shell[data-visual-language="financial-workbench"] .meta-row,
.dashboard-shell[data-visual-language="financial-workbench"] .insight-strip {
  gap: 0;
  border-block: 1px solid var(--line-light);
}

.dashboard-shell[data-visual-language="financial-workbench"] .meta-row .meta-item,
.dashboard-shell[data-visual-language="financial-workbench"] .insight-strip article {
  border: 0;
  border-right: 1px solid var(--line-light);
  border-radius: 0;
  background: transparent;
}

.dashboard-shell[data-visual-language="financial-workbench"] .meta-row .meta-item:last-of-type,
.dashboard-shell[data-visual-language="financial-workbench"] .insight-strip article:last-child {
  border-right: 0;
}

.dashboard-shell[data-visual-language="financial-workbench"] .metric-strip {
  margin: 0;
  border-inline: 0;
  border-radius: 0;
}

.dashboard-shell[data-visual-language="financial-workbench"] .chart-zone,
.dashboard-shell[data-visual-language="financial-workbench"] .content-grid,
.dashboard-shell[data-visual-language="financial-workbench"] .content-grid.wide,
.dashboard-shell[data-visual-language="financial-workbench"] .backtest-grid {
  gap: 0;
  margin: 0;
  border-bottom: 1px solid var(--line);
}

.dashboard-shell[data-visual-language="financial-workbench"] .chart-panel,
.dashboard-shell[data-visual-language="financial-workbench"] .data-panel {
  border: 0;
  border-radius: 0;
  background: var(--panel);
  box-shadow: none;
}

.dashboard-shell[data-visual-language="financial-workbench"] .chart-zone > * + *,
.dashboard-shell[data-visual-language="financial-workbench"] .content-grid > * + *,
.dashboard-shell[data-visual-language="financial-workbench"] .backtest-grid > * + * {
  border-left: 1px solid var(--line);
}

.dashboard-shell[data-visual-language="financial-workbench"] .trend-chart,
.dashboard-shell[data-visual-language="financial-workbench"] .volume-chart,
.dashboard-shell[data-visual-language="financial-workbench"] .financial-chart,
.dashboard-shell[data-visual-language="financial-workbench"] .chart-empty-state,
.dashboard-shell[data-visual-language="financial-workbench"] .source-channel,
.dashboard-shell[data-visual-language="financial-workbench"] .correlation-row,
.dashboard-shell[data-visual-language="financial-workbench"] .compact-row {
  border-radius: 0;
  box-shadow: none;
}

@media (max-width: 800px) {
  .dashboard-shell[data-visual-language="financial-workbench"] {
    width: 100vw;
    padding: 0 12px 32px;
    border-inline: 0;
  }

  .dashboard-shell[data-visual-language="financial-workbench"] .chart-zone > * + *,
  .dashboard-shell[data-visual-language="financial-workbench"] .content-grid > * + *,
  .dashboard-shell[data-visual-language="financial-workbench"] .backtest-grid > * + * {
    border-left: 0;
    border-top: 1px solid var(--line);
  }
}
`;
}

export function comparisonWorkbenchCss(): string {
  return `
/* ==================== COMPARISON WORKBENCH CANVAS ==================== */

.comparison-shell[data-visual-language="financial-workbench"] {
  width: min(1440px, 100vw);
  margin: 0 auto;
  padding: 0 28px 48px;
  border-inline: 1px solid var(--line);
  background: var(--panel);
  --shadow-sm: none;
}

.comparison-shell[data-visual-language="financial-workbench"] .comparison-hero {
  padding: 20px 0 16px;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.comparison-shell[data-visual-language="financial-workbench"] .leader-grid,
.comparison-shell[data-visual-language="financial-workbench"] .chart-grid,
.comparison-shell[data-visual-language="financial-workbench"] .comparison-two-column {
  gap: 0;
  margin: 0;
  border-bottom: 1px solid var(--line);
}

.comparison-shell[data-visual-language="financial-workbench"] .leader-card,
.comparison-shell[data-visual-language="financial-workbench"] .comparison-panel,
.comparison-shell[data-visual-language="financial-workbench"] .comparison-matrix {
  margin: 0;
  border: 0;
  border-radius: 0;
  background: var(--panel);
  box-shadow: none;
}

.comparison-shell[data-visual-language="financial-workbench"] .leader-grid > * + *,
.comparison-shell[data-visual-language="financial-workbench"] .chart-grid > * + *,
.comparison-shell[data-visual-language="financial-workbench"] .comparison-two-column > * + * {
  border-left: 1px solid var(--line);
}

.comparison-shell[data-visual-language="financial-workbench"] .correlation-row,
.comparison-shell[data-visual-language="financial-workbench"] .compact-row {
  border: 0;
  border-bottom: 1px solid var(--line-light);
  border-radius: 0;
  background: transparent;
}

@media (max-width: 900px) {
  .comparison-shell[data-visual-language="financial-workbench"] {
    width: 100vw;
    padding: 0 12px 32px;
    border-inline: 0;
  }

  .comparison-shell[data-visual-language="financial-workbench"] .leader-grid > * + *,
  .comparison-shell[data-visual-language="financial-workbench"] .chart-grid > * + *,
  .comparison-shell[data-visual-language="financial-workbench"] .comparison-two-column > * + * {
    border-left: 0;
    border-top: 1px solid var(--line);
  }
}
`;
}

export function stockSelectionWorkbenchCss(): string {
  return `
/* ==================== SELECTION WORKBENCH CANVAS ==================== */

.selection-shell[data-visual-language="financial-workbench"] {
  width: min(1440px, 100vw);
  margin: 0 auto;
  padding: 0 28px 48px;
  border-inline: 1px solid var(--line);
  background: var(--panel);
  --shadow-sm: none;
}

.selection-shell[data-visual-language="financial-workbench"] .selection-hero {
  padding: 20px 0 16px;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.selection-shell[data-visual-language="financial-workbench"] .selection-hero aside {
  padding: 0 0 0 20px;
  border: 0;
  border-left: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.selection-shell[data-visual-language="financial-workbench"] .summary-grid,
.selection-shell[data-visual-language="financial-workbench"] .asset-grid,
.selection-shell[data-visual-language="financial-workbench"] .chart-grid,
.selection-shell[data-visual-language="financial-workbench"] .main-grid {
  gap: 0;
  margin: 0;
  border-bottom: 1px solid var(--line);
}

.selection-shell[data-visual-language="financial-workbench"] .summary-grid article,
.selection-shell[data-visual-language="financial-workbench"] .asset-card,
.selection-shell[data-visual-language="financial-workbench"] .selection-panel {
  margin: 0;
  border: 0;
  border-radius: 0;
  background: var(--panel);
  box-shadow: none;
}

.selection-shell[data-visual-language="financial-workbench"] .summary-grid > * + *,
.selection-shell[data-visual-language="financial-workbench"] .asset-grid > * + *,
.selection-shell[data-visual-language="financial-workbench"] .chart-grid > * + *,
.selection-shell[data-visual-language="financial-workbench"] .main-grid > * + * {
  border-left: 1px solid var(--line);
}

.selection-shell[data-visual-language="financial-workbench"] .ranking-row {
  border: 0;
  border-bottom: 1px solid var(--line-light);
  border-radius: 0;
  background: transparent;
}

.selection-shell[data-visual-language="financial-workbench"] .selection-main-chart,
.selection-shell[data-visual-language="financial-workbench"] .selection-empty-result {
  border-radius: 0;
  box-shadow: none;
}

@media (max-width: 980px) {
  .selection-shell[data-visual-language="financial-workbench"] {
    width: 100vw;
    padding: 0 12px 32px;
    border-inline: 0;
  }

  .selection-shell[data-visual-language="financial-workbench"] .summary-grid > * + *,
  .selection-shell[data-visual-language="financial-workbench"] .asset-grid > * + *,
  .selection-shell[data-visual-language="financial-workbench"] .chart-grid > * + *,
  .selection-shell[data-visual-language="financial-workbench"] .main-grid > * + * {
    border-left: 0;
  }
}
`;
}

export function holdingWorkbenchCss(): string {
  return `
/* ==================== PORTFOLIO WORKBENCH CANVAS ==================== */

.holding-shell[data-visual-language="financial-workbench"] {
  width: min(1440px, 100vw);
  margin: 0 auto;
  padding: 0 28px 48px;
  border-inline: 1px solid var(--line);
  background: var(--panel);
  --shadow-sm: none;
}

.holding-shell[data-visual-language="financial-workbench"] .holding-hero {
  gap: 14px;
  padding: 20px 0 16px;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.holding-shell[data-visual-language="financial-workbench"] .hero-summary,
.holding-shell[data-visual-language="financial-workbench"] .holding-grid,
.holding-shell[data-visual-language="financial-workbench"] .holding-main-grid,
.holding-shell[data-visual-language="financial-workbench"] .risk-grid {
  gap: 0;
  margin: 0;
  border-bottom: 1px solid var(--line);
}

.holding-shell[data-visual-language="financial-workbench"] .hero-summary article,
.holding-shell[data-visual-language="financial-workbench"] .holding-card,
.holding-shell[data-visual-language="financial-workbench"] .holding-panel,
.holding-shell[data-visual-language="financial-workbench"] .risk-grid article {
  margin: 0;
  border: 0;
  border-radius: 0;
  background: var(--panel);
  box-shadow: none;
}

.holding-shell[data-visual-language="financial-workbench"] .hero-summary > * + *,
.holding-shell[data-visual-language="financial-workbench"] .holding-grid > * + *,
.holding-shell[data-visual-language="financial-workbench"] .holding-main-grid > * + *,
.holding-shell[data-visual-language="financial-workbench"] .risk-grid > * + * {
  border-left: 1px solid var(--line);
}

.holding-shell[data-visual-language="financial-workbench"] .portfolio-chart-wrap,
.holding-shell[data-visual-language="financial-workbench"] .correlation-row,
.holding-shell[data-visual-language="financial-workbench"] .chart-empty {
  border-radius: 0;
  box-shadow: none;
}

.holding-shell[data-visual-language="financial-workbench"] .correlation-row {
  border: 0;
  border-bottom: 1px solid var(--line-light);
  background: transparent;
}

@media (max-width: 980px) {
  .holding-shell[data-visual-language="financial-workbench"] {
    width: 100vw;
    padding: 0 12px 32px;
    border-inline: 0;
  }

  .holding-shell[data-visual-language="financial-workbench"] .hero-summary > * + *,
  .holding-shell[data-visual-language="financial-workbench"] .holding-grid > * + *,
  .holding-shell[data-visual-language="financial-workbench"] .holding-main-grid > * + *,
  .holding-shell[data-visual-language="financial-workbench"] .risk-grid > * + * {
    border-left: 0;
  }
}
`;
}
