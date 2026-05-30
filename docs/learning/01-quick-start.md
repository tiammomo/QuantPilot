# 01. 本地启动与健康检查

目标：把 QuantPilot 在本地完整跑起来，并确认首页、策略平台、Skills、评测、数据平台和运维平台都能打开。

![首页工作台](assets/home.png)

## 前置条件

- Node.js `>= 20.19.0`
- npm `>= 10`
- Docker / Docker Compose
- Python `3.14`
- uv

## 1. 安装前端依赖

```bash
npm install
cp .env.example .env
cp .env.example .env.local
```

需要把 `.env` 或 `.env.local` 里的模型 token 替换成自己的值。真实密钥只放本地，不提交到 Git。

## 2. 启动基础设施

```bash
npm run db:up
npm run db:init
npm run db:doctor
```

`db:up` 会拉起 TimescaleDB 和 Redis。TimescaleDB 本质上是带时序扩展的 PostgreSQL 镜像，用来同时承载普通关系表和量化时序表。

## 3. 启动市场数据后端

```bash
cd services/market-data
uv sync --extra baostock --extra akshare
uv run quantpilot-market-api
```

健康检查：

```bash
curl http://127.0.0.1:8000/health
curl "http://127.0.0.1:8000/api/v1/quotes/realtime/600519"
```

## 4. 启动主前端

回到项目根目录：

```bash
npm run dev
```

默认访问：

```text
http://localhost:3000
```

如果 `3000` 被占用，先释放旧进程再启动。主前端应优先保持在 `3000`，生成项目预览会从 `4100` 往后分配端口，`3100` 留给 Loki。

## 5. 页面巡检

打开这些页面确认没有错误覆盖层：

| 页面 | 地址 |
| --- | --- |
| 首页工作台 | `http://localhost:3000` |
| 策略平台 | `http://localhost:3000/strategy-platform` |
| Skills 管理 | `http://localhost:3000/skills` |
| 数据平台 | `http://localhost:3000/data-platform` |
| 运维平台 | `http://localhost:3000/ops-platform` |
| 评测平台 | `http://localhost:3000/eval-platform` |

## 6. 最小质量门

```bash
npm run lint
npm run type-check
npm run check:skills
npm run check:validation-repair
```

后端：

```bash
cd services/market-data
uv run ruff check .
uv run pytest
```

如果只是改文档，前端类型检查和 lint 仍然值得跑一遍，避免当前工作区已有问题被误以为是文档改动造成的。
