# Dashboard Final 数据契约

在页面生成、模板修复或 final-data 验证失败时读取本文件。场景组件选择仍以 `scenario_templates.md` 为准，指标聚合规则仍以 `visual_judgement.md` 为准。

## 根对象

`data_file/final/dashboard-data.json` 必须是 JSON object，并至少包含一种真实业务数据：

- `quote` / `kline`
- `assets[]` / `comparison`
- `holdings[]` / `portfolio`
- `financials`
- `backtest`
- `announcements[]`

根对象应保留 `visualization`：

```json
{
  "visualization": {
    "template_id": "single-stock-diagnosis",
    "variant_id": "price-volume-workbench",
    "required_components": ["quote-strip", "price-chart", "source-panel"],
    "rendered_components": ["quote-strip", "price-chart", "source-panel"],
    "missing_components": []
  }
}
```

允许平台兼容读取 camelCase `templateId` / `variantId`，但写入 final 数据时优先使用 snake_case。`required_components` 中未渲染的项必须进入 `missing_components`，不得静默消失。

## 标的覆盖

- 单标的可以来自根 `symbol`、`quote.symbol` 或 `kline.symbol`。
- 多标的必须在 `assets[].symbol`、`comparison.rows[].symbol` 或 `holdings[].symbol` 覆盖 run plan 的全部标的。
- 证券代码比较时忽略大小写；不要把名称当作代码。
- 缺失标的必须保留真实失败原因，不能用主标的数据复制填充。

## 禁止数据

final JSON 中不能出现：

- `MOCK_DATA`、`SAMPLE_DATA`、`STATIC_QUOTES` 或宣称为真实结果的示例/模拟数据。
- token、API key、cookie、authorization 等明文秘密。
- 供浏览器直接请求的外部 `http://` / `https://` 数据地址。

来源证据可以保留公开 endpoint 字符串，但页面只能绑定本地 final 文件或同源 `/api/market/**`。

## 脚本校验

```bash
python scripts/validate_dashboard_contract.py \
  --input data_file/final/dashboard-data.json \
  --expected-template stock-selection \
  --expected-symbol 600519.SH \
  --expected-symbol 000858.SZ \
  --pretty
```

退出码 `0` 只表示结构合同通过；页面仍需通过 build、预览、金融图表、证据和响应式验证。
