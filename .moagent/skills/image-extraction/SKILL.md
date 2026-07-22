---
name: image-extraction
description: Use this skill whenever a QuantPilot task includes uploaded images or .data-agent/attachments.json, especially portfolio/account screenshots that need holdings, cost, cash, PnL, and position fields extracted before market data and visualization.
---

# QuantPilot 图片提取能力

本 skill 用于承接用户上传的图片附件，尤其是券商持仓、账户、成交或自选股截图。它负责把图片输入转换为可追溯的结构化证据，再交给行情、指标、数据质量和可视化能力继续处理。

## 资源与确定性归一化

处理持仓/账户截图时读取 [portfolio-image-contract.md](references/portfolio-image-contract.md)。它定义图片元数据、视觉字段、外部补全值之间的证据边界，以及无法识别时的失败规则。

在视觉工具返回真实字段后运行归一化脚本：

```bash
python .moagent/skills/image-extraction/scripts/normalize_extraction.py --input extraction-input.json
```

`--input` 支持 JSON 对象、文件路径或 `-`（stdin）。脚本只向 stdout 输出 JSON，不执行 OCR、不联网、不写文件；它把金额/百分比等格式确定性归一化，把无法可靠解析的值置为 `null` 并加入 `manual_confirmation_fields`。无效输入以非零状态退出。由平台把输出写入证据文件。

## 何时必须使用

当出现以下任意情况时，必须先使用本能力：

- 用户上传了图片。
- 当前项目存在 `.data-agent/attachments.json`。
- 用户问题包含“截图、图片、持仓、账户、仓位、调仓、盈亏、成本、可用、现金、总资产”等词。

## 标准流程

1. 读取 `.data-agent/attachments.json`，确认附件路径、文件名、公开 URL 和提取契约。
2. 调用 `mcp__QuantPilotImage__quant_extract_uploaded_image`：
   - 默认参数：`{"attachmentContextPath": ".data-agent/attachments.json", "prompt": "<用户问题>"}`
   - 该工具会校验图片文件是否存在，并返回格式、尺寸、哈希、字段契约和缺失字段。
3. 如果 `mcp__MiniMax__understand_image` 可用，再调用它识别图片视觉内容。
4. 用 `normalize_extraction.py` 标准化识别字段，由平台将结果写入：

```text
evidence/image_extraction.json
```

5. 在最终数据中保留：

```text
data_file/final/dashboard-data.json -> imageExtraction
```

## 持仓截图字段契约

优先抽取：

- 账户：`account_total_asset`、`cash_available`、`market_value`、`daily_pnl`、`total_pnl`、`position_ratio`
- 持仓：`holdings[].name`、`holdings[].symbol_if_visible_or_resolved`、`holdings[].quantity`、`holdings[].cost_price`、`holdings[].current_price`、`holdings[].market_value`、`holdings[].pnl`、`holdings[].pnl_percent`
- 证据：图片路径、文件哈希、识别方式、需要人工确认的字段

无法确定的字段必须写 `null`，并放进 `needs_manual_confirmation_fields`，不要猜测或编造。

## 后续衔接

- 如果识别到股票名称或代码，下一步使用 `quant-symbol-resolver` 标准化标的。
- 如果识别到持仓数量、成本和现金，后续 `quant-market-data` 应获取实时行情和 K 线。
- `data-quality` 必须把截图识别、行情补全和人工确认字段分开说明。
- `dashboard-visualization` 生成持仓/调仓看板时，必须展示图片字段来源和缺失项。

## Workspace 回答协作

- 继承平台统一的五阶段进度；不自行重启阶段、重复进度标题、重复问题识别表或维护 Todo。
- 只提供本 skill 已确认的可验证事实、真实缺口和下一步，不输出隐藏推理、完整工具参数或占位式 “Skill executing...”。
- 本 skill 只贡献附件数量、图片哈希、已识别字段、置信边界和待人工确认字段；阶段编号与展示由平台统一维护。

## 禁止事项

- 不要忽略图片附件。
- 不要只说“我看不到图片”就停止。
- 不要把截图中没有出现的信息当作用户提供事实。
- 不要把视觉识别失败伪装成成功。
