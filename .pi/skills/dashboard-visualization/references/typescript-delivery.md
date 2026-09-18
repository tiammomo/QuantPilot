# 动态金融数据的 TypeScript 边界

在平台验证报告定位到类型错误时读取；正常生成优先复用模板已有守卫函数。

## TypeScript 稳定性规则

生成 `app/page.tsx` 时必须按严格 TypeScript 写法处理动态金融数据：

- 所有从 JSON 读取的数据先进入 `JsonRecord | null` 或 `JsonRecord[]`，不要直接把 `unknown` 当作具体对象访问。
- 嵌套对象的每一层都必须单独经过 `asRecord()`；禁止在 `unknown` 字段上继续可选链，例如 `asRecord(data?.financials)?.summary?.latest_report_date` 仍然会触发 TypeScript 错误。应改为：

```ts
const financials = asRecord(data?.financials);
const financialSummary = asRecord(financials?.summary);
const latestReportDate = String(financialSummary?.latest_report_date ?? '—');
```

- `assets[]`、`comparison.rows[]`、`announcements.announcements[]`、`financials.reports[]` 等动态数组必须写成 `JsonRecord[]`：

```ts
const assets = asArray(data?.assets)
  .map(asRecord)
  .filter((item): item is JsonRecord => Boolean(item));
```

- 对 `flatMap()` 里新增字段的对象必须显式标注为 `JsonRecord`，避免 TypeScript 推断成 `{ symbol: unknown; name: unknown }` 这类窄类型：

```ts
const rows: JsonRecord[] = assets.flatMap((asset) => {
  const announcements = asRecord(asset.announcements);
  return asArray(announcements?.announcements)
    .map(asRecord)
    .filter((item): item is JsonRecord => Boolean(item))
    .map((item): JsonRecord => ({
      ...item,
      symbol: item.symbol ?? asset.symbol,
      name: item.name ?? asset.name,
    }));
});
```

- 排序、格式化和渲染时一律使用 `row['field']` 或 `row.field` 的 `unknown` 值进入 `String()`、`numeric()`、`formatDate()`、`formatNumber()`，不要声明不完整的结构类型。
- JSX 中不能直接渲染动态 JSON 的 unknown/object 字段；例如 `rows[0]?.period`、`row.value`、`source.metadata` 必须先进入 `String()`、`formatDate()`、`formatNumber()` 或 `pickString()` 后再渲染。
- 不能用 `as any` 扫过类型错误；如果字段不确定，增加守卫函数或把数组显式标注为 `JsonRecord[]`。
- 如果页面新增公告、财务、估值、相关性、流动性等模块，代码必须满足严格 TypeScript，确保平台 build 不会报告 “Property does not exist on type ...”。

