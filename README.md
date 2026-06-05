# 北京旅游 Agent

北京旅游 Agent 是一个面向北京本地游玩的智能路线规划工作台。系统基于本地 POI、餐厅、文化地点、UGC 评论特征和高德通勤补全数据，生成可解释、可调整的旅游路线。

项目已经清理掉历史量化平台包袱，不再包含股票策略平台、金融数据服务、时序数据库量化 SQL 或旧评测平台。

## 核心能力

- 自然语言解析：把用户的区域、时长、预算、餐饮和偏好约束转成结构化规划条件。
- 本地数据检索：读取 `travel-data/processed` 中的北京 POI、餐厅、文化地点和 UGC 特征。
- 通勤补全：使用 `travel_commute_edges` 表中的景点-景点、景点-餐厅、餐厅-餐厅通勤边。
- 路线规划：生成多套候选方案，并给出预算、时长、步行、转场和风险解释。
- 动态重规划：支持继续追加、删除、替换或保留地点。
- 数据平台：`/data-platform` 查看旅游能力、数据源和接口健康状态。

## 数据位置

- 原始/处理后的 POI 数据：`travel-data/processed`
- Wiki 知识库：`travel-data/wiki`
- 通勤补全 SQL：`sqls/008-travel-commute-data.sql`
- 旅游知识库 SQL：`sqls/009-travel-knowledge-base.sql`
- 通勤采集 CSV 导出：`tmp/exports/travel_commute_edges_completed_9000.csv`
- 数据库表：`travel_commute_edges`

## 快速启动

```bash
npm install
cp .env.example .env
npm run db:up
npm run db:init
npm run travel:db:import
npm run travel:db:doctor
npm run dev
```

默认访问：

```text
http://localhost:3000
```

如果你已经在本机用旧数据库名保存了采集结果，可以继续在 `.env` 中保留原来的 `DATABASE_URL`，不需要为了改名重新采集。

## 常用命令

```bash
npm run dev
npm run build
npm run lint
npm run type-check

npm run db:up
npm run db:down
npm run db:init
npm run db:doctor
npm run db:psql

npm run travel:db:init
npm run travel:db:import
npm run travel:db:doctor
npm run travel:wiki:build
npm run travel:amap:backfill

npm run check:travel
npm run check:travel-commute
npm run check:travel-query-plan
```

## 旅游 API

- `GET /api/v1/travel/health`
- `GET /api/v1/travel/options`
- `GET /api/v1/travel/pois`
- `POST /api/v1/travel/parse-and-plan`
- `POST /api/v1/travel/plan`
- `POST /api/v1/travel/replan`
- `POST /api/v1/travel/query-plan`
- `GET /api/v1/travel/evidence/{poi_id}`

## 项目结构

| 路径 | 说明 |
| --- | --- |
| `src/app/` | Next.js 页面和 API |
| `src/app/api/v1/travel/` | 旅游规划 API |
| `src/lib/travel/` | 语义解析、SQL 查询、路线规划、Wiki 检索和重排 |
| `scripts/travel/` | 旅游数据库初始化、导入、诊断、Wiki 构建和高德通勤补全 |
| `scripts/checks/` | 旅游链路检查脚本 |
| `sqls/` | 旅游数据库 SQL |
| `travel-data/` | 本地旅游数据和 Wiki |
| `data/projects/` | 本地生成的任务工作空间，默认不提交 |
| `tmp/` | 本地导出、采集和检查产物，默认不提交 |

## 注意事项

- 通勤时间、排队风险和性价比是本地静态或历史数据估算，不代表实时导航、实时排队或实时营业状态。
- 真实 key 请放在 `.env` 或 `.env.local`，不要提交到 Git。
- 高德 API 调用建议控制频率，默认脚本支持通过参数调整延迟。
