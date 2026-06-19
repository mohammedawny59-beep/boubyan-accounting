# Dashboard Page — Design Override
**Inherits:** `MASTER.md` | **Overrides:** KPI colors, chart palette, animation stagger

## KPI Grid Layout
- 5 cards, `repeat(auto-fit, minmax(190px, 1fr))`
- Gap: `14px`
- Order: Revenue → Net → Insurance → Commission → Pending

## KPI Card Animation
- Counter: `easeOutQuart` over `1100ms` on data load
- Stagger: `50ms` per card via IntersectionObserver
- Refresh flash: `kpiPulse` 600ms when data updates

## ECharts Color Palette (dashboard charts)
```js
color: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6']
```

## Chart Tooltip Override
```css
.echarts-tooltip-override {
  background: var(--surface2);
  border: 1px solid var(--borderAct);
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
}
```

## Widget IDs (DashWidgets system)
| ID | Widget |
|----|--------|
| `w-kTotal` | إجمالي الإيرادات |
| `w-kNet` | صافي الإيرادات |
| `w-kIns` | حصة التأمين |
| `w-kComm` | إجمالي العمولات |
| `w-kPend` | عمولات معلّقة |
| `w-ins-box` | تفصيل التأمين |
| `w-charts-row` | الرسوم البيانية |
| `w-chart-daily` | الرسم اليومي |
| `w-daily-table` | التفصيل اليومي |
