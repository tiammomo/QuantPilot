# 北京旅游 Agent 文档

当前文档只覆盖旅游 Agent 主链路，不再保留历史量化策略平台、金融数据服务或旧评测平台资料。

## 文档入口

- [项目结构](project-structure.md)
- [本地产物边界](local-generated-files.md)
- [故障排查](troubleshooting.md)

## 关键数据路径

- `travel-data/processed`：内置北京 POI、餐厅、文化地点和 UGC 特征。
- `travel-data/wiki`：由本地数据生成的 Markdown 知识库。
- `sqls/008-travel-commute-data.sql`：通勤边 schema。
- `sqls/009-travel-knowledge-base.sql`：旅游知识库 schema。
- `tmp/exports/travel_commute_edges_completed_9000.csv`：已导出的通勤补全结果。
