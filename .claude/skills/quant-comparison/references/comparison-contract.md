# 多标的比较契约

## 核心原则

比较的完整性由“请求覆盖 + 共同窗口 + 同义指标 + 数据血缘”共同决定。缺任一请求标的都不是部分成功；不得用主标的复制或代表其他标的。

## 最小结构

```json
{
  "requestedSymbols": ["600519.SH", "000001.SZ"],
  "assets": [
    {"symbol": "600519.SH", "source": "quant.stock_bars"},
    {"symbol": "000001.SZ", "source": "quant.stock_bars"}
  ],
  "comparison": {
    "window": {"start": "2026-01-01", "end": "2026-07-15"},
    "rows": [
      {
        "symbol": "600519.SH",
        "period_return": 0.08,
        "max_drawdown": -0.12,
        "volatility": 0.22,
        "as_of": "2026-07-15",
        "source": "quant.stock_bars"
      },
      {
        "symbol": "000001.SZ",
        "period_return": 0.04,
        "max_drawdown": -0.09,
        "volatility": 0.18,
        "as_of": "2026-07-15",
        "source": "quant.stock_bars"
      }
    ]
  }
}
```

如果每行带 `window_start/window_end`，其值必须等于顶层共同窗口。`volatility20d` 可替代 `volatility`；其他别名必须在生成比较对象前规范化。

## 覆盖与唯一性

- `requestedSymbols` 至少两个且不重复。
- 每个请求代码在 `assets[]` 和 `comparison.rows[]` 中恰好出现一次。
- 允许对象包含额外基准标的，但必须显式标记 benchmark；默认校验器将额外行作为 warning。
- symbol 比较忽略大小写与首尾空格，但最终输出应统一格式。

## 共同口径

- 所有行使用相同起止日期、频率、复权、币种和单位。
- `period_return` 使用小数，例如 8% 写为 `0.08`。
- `max_drawdown` 使用小于等于 0 的小数；越接近 0 表示回撤更小。
- 波动率必须非负，并说明是区间、日频还是年化口径。
- 缺失值必须为 `null` 并附原因；不得改写为 0 后参与排名。

## Leaders 规则

只有所有参与排名的行都具有对应有效指标时才生成该指标 leader。收益取最大值；最大回撤默认取最接近 0 的值；波动率最低仅描述风险特征，不等同于“最好”。同值并列时保留全部代码或声明稳定排序规则。

## 数据血缘

每个 asset 和 row 至少提供 `source/provider` 之一及 `as_of`。如果数据源、截止日或覆盖窗口不同，先求共同窗口重新计算，不得直接横排原始指标。

## 验证

`scripts/validate_comparison.py` 对完整 dashboard JSON 或直接比较对象运行。退出码 1 表示覆盖、窗口或指标契约被破坏；退出码 2 表示输入不可读。warning 不阻断，但必须进入最终数据限制。
