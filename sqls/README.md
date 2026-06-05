# 北京旅游 Agent SQL

`sqls/` 只保存旅游 Agent 需要的 PostgreSQL schema，所有 SQL 都应保持可重复执行。

| 文件 | 说明 |
| --- | --- |
| `008-travel-commute-data.sql` | 通勤边表，保存景点-景点、景点-餐厅、餐厅-餐厅的步行/驾车/公交结果 |
| `009-travel-knowledge-base.sql` | 旅游 Wiki 文档、分块与检索所需表 |

初始化：

```bash
npm run db:init
```

旅游数据导入：

```bash
npm run travel:db:import
npm run travel:db:doctor
```
