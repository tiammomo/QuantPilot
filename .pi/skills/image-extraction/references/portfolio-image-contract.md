# 持仓图片证据契约

在处理券商持仓、账户、成交或自选股截图时读取本参考。非图片任务不要加载。

## 证据层级

严格区分三类值：

1. **图片元数据**：平台直接读取的路径、格式、尺寸、字节数和 SHA-256。
2. **视觉识别值**：OCR/视觉 provider 从截图中实际看到的文字和数值。
3. **外部补全值**：标的解析、实时行情或历史数据接口返回的字段。

不得把外部行情价格写成“截图当前价”，也不得把模型推断写成用户提供事实。每个字段要能追溯到上述一层。

## 图片元数据

每张图片至少保留：

```json
{
  "path": "uploads/portfolio.png",
  "name": "portfolio.png",
  "mimeType": "image/png",
  "width": 1170,
  "height": 2532,
  "sha256": "64-character-hex-digest"
}
```

哈希绑定原始证据。识别后图片内容发生变化时必须重新计算，不能复用旧结果。

## 结构化字段

账户字段：

- `account_total_asset`
- `cash_available`
- `market_value`
- `daily_pnl`
- `total_pnl`
- `position_ratio`

持仓字段：

- `holdings[].name`
- `holdings[].symbol_if_visible_or_resolved`
- `holdings[].quantity`
- `holdings[].cost_price`
- `holdings[].current_price`
- `holdings[].market_value`
- `holdings[].pnl`
- `holdings[].pnl_percent`

数值允许保留负数。百分比字段以百分点表达，例如截图 `-3.25%` 标准化为 `-3.25`，不能自动除以 100。无法可靠读取的字段写 `null`。

## 标准化脚本输入

先由图片工具产生真实元数据和视觉结果，再运行：

```json
{
  "runId": "request-123",
  "images": [
    {
      "path": "uploads/portfolio.png",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ],
  "extracted_at": "2026-07-15T02:00:00.000Z",
  "extractedFields": {
    "account_total_asset": "¥1,250,000.00",
    "cash_available": null,
    "holdings": [
      {
        "name": "贵州茅台",
        "symbol": "600519",
        "quantity": "100",
        "cost_price": "1420.50",
        "current_price": "--"
      }
    ]
  }
}
```

`scripts/normalize_extraction.py` 只做确定性格式归一化。它不会 OCR，也不会补行情；无法解析的值变为 `null` 并进入 `manual_confirmation_fields`。

## 证据落盘

将归一化结果纳入 `evidence/image_extraction.json`，并在最终数据保留 `imageExtraction`。数据质量证据同时记录：

- 图片数量和哈希。
- 视觉 provider 及识别时间（真实存在时）。
- 未确认字段列表。
- 使用 symbol resolver 或行情接口补全的字段及其独立来源。
- 图片模糊、裁切、遮挡、单位不明等限制。

## 失败模式

| 失败 | 处理 |
| --- | --- |
| 附件路径不存在 | 停止该附件识别并报告，不伪造元数据 |
| 格式不受支持 | 保留附件事实，标记视觉识别失败 |
| OCR 把 `8` 识别成 `B` | 字段置 `null`，请求确认 |
| 截图未显示单位 | 保留原值或置空，不自行假定元/万元 |
| 证券名称可见但代码不可见 | 用 symbol resolver 补全并标明来源 |
| 现价来自行情 API | 与截图字段分开，不覆盖截图证据 |
| 无视觉 provider | 输出 `metadata_ready` 和全部人工确认字段 |
