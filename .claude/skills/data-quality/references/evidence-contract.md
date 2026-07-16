# 数据来源与质量证据契约

在生成或修复 `evidence/sources.json`、`evidence/data_quality.json`，或者判断 warning/error 边界时读取本参考。普通数据获取阶段不必加载。

## 不可伪造原则

- `fetched_at` 只记录真实请求/读取时间，不得用当前时间补空值。
- `as_of`/`quote_time` 是数据本身的时间，不能用 `fetched_at` 替代。
- `source` 与 endpoint 必须来自真实响应或注册表。
- `row_count=0` 与字段缺失是质量事实，不能用 mock 数据修复。
- evidence 不得包含 token、cookie、authorization、密码或 API key。

## `sources.json`

```json
{
  "schemaVersion": 1,
  "runId": "request-123",
  "created_at": "2026-07-15T02:00:00.000Z",
  "sources": [
    {
      "dataset": "daily_kline",
      "symbol": "600519",
      "name": "贵州茅台",
      "source": "timescaledb",
      "endpoint": "GET /api/v1/research/bars/600519",
      "artifact_path": "data_file/raw/bars-600519.json",
      "as_of": "2026-07-14T15:00:00+08:00",
      "fetched_at": "2026-07-15T02:00:00.000Z",
      "status": "success"
    }
  ]
}
```

`sources` 必须非空。端点如含查询参数，只保留不敏感参数。

## `data_quality.json`

```json
{
  "schemaVersion": 1,
  "runId": "request-123",
  "status": "warning",
  "created_at": "2026-07-15T02:00:00.000Z",
  "datasets": [
    {
      "dataset": "daily_kline",
      "symbol": "600519",
      "row_count": 118,
      "source": "timescaledb",
      "fetched_at": "2026-07-15T02:00:00.000Z",
      "as_of": "2026-07-14T15:00:00+08:00",
      "missing_fields": ["turnover"],
      "warnings": ["目标 120 条，实际 118 条。"],
      "status": "warning",
      "required": true
    }
  ],
  "checks": [
    {
      "id": "daily_kline_quality",
      "dataset": "daily_kline",
      "status": "warning",
      "row_count": 118,
      "missing_fields": ["turnover"],
      "summary": "样本略短且缺少换手率。"
    }
  ],
  "warnings": ["目标 120 条，实际 118 条。"],
  "limitations": ["结论不包含换手率信号。"]
}
```

## 状态决策

| 状态 | 条件 | 下游行为 |
| --- | --- | --- |
| `ok` | 核心数据非空、关键字段齐全、来源和时间可追溯 | 正常生成页面 |
| `warning` | 非关键字段缺失、轻微样本不足、provider 降级或数据较旧 | 生成页面并显式展示限制 |
| `error` | 必需数据为空/失败，或 critical field 缺失 | 停止依赖该数据的结论，展示真实错误 |

多个数据集取最严重状态：任一 `error` 则整体 `error`，否则任一 `warning` 则整体 `warning`。

## 脚本输入

`scripts/assess_data_quality.py` 接受已验证的数据集元数据：

```json
{
  "runId": "request-123",
  "created_at": "2026-07-15T02:00:00.000Z",
  "datasets": [
    {
      "dataset": "daily_kline",
      "symbol": "600519",
      "source": "timescaledb",
      "endpoint": "GET /api/v1/research/bars/600519",
      "artifact_path": "data_file/raw/bars-600519.json",
      "fetched_at": "2026-07-15T02:00:00.000Z",
      "as_of": "2026-07-14T15:00:00+08:00",
      "row_count": 120,
      "required_fields": ["close", "volume"],
      "critical_fields": ["close"],
      "available_fields": ["close", "volume"],
      "missing_fields": [],
      "warnings": [],
      "status": "success",
      "required": true
    }
  ],
  "limitations": ["行情数据仅用于研究辅助。"]
}
```

脚本输出两个可分别落盘的对象：`sources` 和 `data_quality`。它不会产生时间戳或读取数据文件。

## 失败模式

| 失败 | 处理 |
| --- | --- |
| response 成功但数据数组为空 | `row_count=0`，必需数据标记 `error` |
| 只有 source 无 endpoint/产物 | 标记缺失，不宣称证据完整 |
| `fetched_at` 存在但 `as_of` 缺失 | 可 warning；页面不得声称数据实时 |
| provider 降级 | 保留实际 provider 和降级警告 |
| 图片 OCR 与行情字段混合 | 拆成不同 dataset/source |
| 发现敏感凭据 | 拒绝生成证据并非零退出 |
