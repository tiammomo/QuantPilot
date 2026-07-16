# 用户、权限与会话管理

QuantPilot 支持项目级可配置登录。它默认保持 `disabled`，兼容原来的本地单用户开发方式；部署到共享环境时应切换为 `local`，由 PostgreSQL 保存用户、凭据、会话和登录限流状态。

## 能力边界

启用登录后，访问边界统一覆盖：

- Next.js 页面和 `/api/*` 接口；匿名页面请求跳转到 `/login`，匿名 API 请求返回结构化 `401`。
- `/api/ws/*` WebSocket 握手；握手时再次查询数据库会话，不能只依赖页面已登录。
- 非安全方法的 API 来源校验；浏览器请求必须同源，无 `Origin` 的可信自动化调用需携带 `X-QuantPilot-Request: same-origin`。
- 账号或邮箱密码登录；本机开发提供 `admin / admin`，显式配置的正式密码最小 12 字符，公开注册默认关闭。
- 数据库会话和数据库登录限流；登录默认每分钟最多 5 次尝试，会话默认 12 小时。
- 平台角色 `admin/member`、账号 capability 与项目角色 `owner/editor/viewer` 分离；后端按默认拒绝原则校验页面、API 与 WebSocket，不能只依赖前端隐藏按钮。
- 管理员可创建、停用、恢复用户，重置临时密码、撤销会话并分配项目权限；用户可修改密码并管理自己的登录设备。
- 管理员创建或重置的普通临时凭据必须首次改密；本机固定默认管理员 `admin / admin` 不触发首次改密。改密会保留当前会话并撤销其他会话。
- 登录、退出、改密、用户管理、项目授权和拒绝访问会写入安全审计表，审计记录不保存密码或会话 token。

`/api/auth/*` 由认证组件自行完成 Origin/CSRF 校验。只有不包含基础设施细节的 `/api/health` 保持公开，供负载均衡器检查进程存活；包含数据库和 Docker 状态的 `/api/infrastructure/health` 仍要求登录。FastAPI 市场数据服务是内部服务边界，不应直接暴露到公网；它的写接口继续由 `QUANTPILOT_MARKET_ADMIN_TOKEN` 保护。

## 启用本地账号登录

先应用只新增表的认证迁移：

```bash
npx prisma migrate deploy
npx prisma migrate status
```

本机开发在 `.env.local` 设置基础认证配置：

```bash
QUANTPILOT_AUTH_MODE=local
QUANTPILOT_AUTH_SECRET=<至少-32-字符-的随机密钥>
BETTER_AUTH_URL=http://localhost:3000
QUANTPILOT_AUTH_SECURE_COOKIES=0
QUANTPILOT_AUTH_TRUSTED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

也可以让开发环境脚本生成独立随机会话密钥并写入上述本机配置：

```bash
npm run ensure:env -- --enable-auth
```

该命令只修改被 Git 忽略的本机环境文件，不会把密钥写入示例配置或提交记录。

执行 `npm run auth:bootstrap` 时，如果管理员变量全部留空、URL 是 localhost/127.0.0.1，且不是 production/strict 模式，会创建本地默认账号：

```text
账号：admin
密码：admin
```

生产、strict 模式或非本机地址不会接受这组默认凭据，必须显式设置：

```bash
QUANTPILOT_AUTH_ADMIN_EMAIL=admin@example.com
QUANTPILOT_AUTH_ADMIN_PASSWORD=<至少-12-字符-的强密码>
QUANTPILOT_AUTH_ADMIN_NAME=QuantPilot 管理员
```

生产环境的 `BETTER_AUTH_URL` 与可信来源应使用实际 HTTPS 地址，同时设置 `QUANTPILOT_AUTH_SECURE_COOKIES=1`。随机密钥可用 `openssl rand -base64 32` 生成，不要把密钥或管理员密码提交到 Git。

创建或维护管理员：

```bash
npm run auth:bootstrap
```

命令可重复执行。本机使用开发默认值时，每次都会确保默认管理员密码为 `admin`、取消首次改密要求、撤销旧会话并补齐管理员角色和历史项目归属。认领历史项目后，同一事务会把管理员的 `projects.owned` 实际用量校准到权威项目数；管理员仍保持无限额度，但真实占用可审计。显式配置管理员邮箱和强密码时，命令会更新密码并撤销旧会话。完成后重启 Web 服务，访问 `/login` 登录。共享环境必须使用显式强密码。为了减少正式密码在磁盘上的停留时间，可在初始化完成后从 `.env.local` 删除 `QUANTPILOT_AUTH_ADMIN_PASSWORD`；日常运行不读取它。

## 页面、角色与日常操作

| 入口 | 使用者 | 责任 |
| --- | --- | --- |
| `/login` | 匿名用户 | 邮箱或本机 `admin` 别名登录 |
| `/account/security` | 已登录用户 | 首次改密、日常改密、查看和撤销自己的登录会话 |
| `/account/usage` | 已登录用户 | 查看自己的有效 capability、配额窗口和实际 `used/reserved/remaining` |
| `/admin/users` | 平台管理员 | 用户生命周期、平台角色、项目成员、权限/配额、会话撤销和安全审计 |

平台 `admin` 可治理所有项目和平台配置；`member` 只能进入明确授权的项目。项目 `owner` 可删除项目、连接外部服务和管理成员，`editor` 可修改项目与运行任务，`viewer` 只读。创建项目的用户自动成为 owner；升级前没有 owner 的历史项目由第一次管理员 bootstrap 接管。

管理员创建用户后，页面只展示一次随机初始密码。应通过独立安全渠道发送，用户首次登录必须改密。停用账号和重置密码都会立即撤销该用户全部会话；系统禁止管理员停用自己或停用/降级最后一个可用管理员。

## Capability 与项目角色

权限判定分成两个相互独立的平面：账号 capability 回答“这个用户能否使用某类能力”，项目角色回答“这个用户能否在这个项目里执行该操作”。项目范围的操作必须同时通过两层校验：

```text
有效项目权限 = 账号权限模板/用户覆盖允许 ∩ owner/editor/viewer 角色允许
```

因此，给用户分配项目 `owner` 不会绕过账号 capability 的显式拒绝；反过来，仅授予 `project.delete` capability 也不会让非项目成员删除项目。缺少项目上下文时默认拒绝，普通用户不是项目成员时返回 `404`，避免通过响应差异枚举项目。代理层只负责尽早拒绝，route/service 的 `requireAction` 才是权威判定边界。

内置并写入数据库的普通用户模板如下：

| 模板 | 默认用途 | 主要能力边界 |
| --- | --- | --- |
| `member-default` | 新建普通成员的默认模板 | 项目生命周期、源码、项目密钥与服务、Agent、量化读取/问题改写/策略运行、报告读取与生成；仍受项目角色约束，不含平台治理、策略管理和真实报告推送 |
| `readonly-default` | 审阅、演示或外部协作账号 | 只允许读取已授权项目和源码、量化数据与研究报告，不允许创建项目、运行 Agent 或修改资源 |

用户级 `allow/deny` 覆盖可设置到期时间；有效的显式 `deny` 优先于模板和其他 `allow`。未知 capability、无法加载策略或模板未授予都按拒绝处理。能力目录及其 `account/project/platform` scope 由 [`config/access-control.json`](../config/access-control.json) 统一声明，数据库模板只保存目录 key，不允许 API 写入未知 key。

平台管理员固定拥有目录中的全部 capability。项目范围接口仍必须给出合法项目 ID，但管理员不依赖普通成员模板或 membership；管理页面也不允许给管理员添加权限限制。认证关闭的本地单用户模式使用等价的系统管理员身份，便于兼容原有开发流程。

## 使用配额与实际用量

普通成员使用配额模板，必要时可叠加有到期时间的用户级覆盖。解析顺序是“管理员无限 > 有效用户覆盖 > 用户模板 > 默认模板”；尚未配置的新 metric 以无限 `observe` 方式继续服务并记录用量，避免上线新指标时造成全站故障，但需要硬门禁的资源必须先在模板中配置规则。

| enforcement | 超额时行为 | 适用阶段 |
| --- | --- | --- |
| `observe` | 允许请求并持续计量，供建立真实分布基线 | 新 metric 或成本指标初期 |
| `warn` | 允许请求，响应/管理视图可显示 `exceeded`，由运营侧提示或告警 | 已有阈值但暂不阻断 |
| `hard` | 预留阶段原子检查 `used + reserved + requested`，超额返回 `429 QUOTA_EXCEEDED` 和 `Retry-After` | 项目数、并发数等确定性资源 |

默认 `member-default` 配额如下。日/月窗口按 UTC 边界计算，`lifetime` 使用固定全生命周期窗口：

| metric | 默认上限 | enforcement / 窗口 | 口径 |
| --- | ---: | --- | --- |
| `projects.owned` | 10 | `hard` / `lifetime` | 用户创建并结算的自有项目 |
| `agent.concurrent` | 2 | `hard` / `lifetime` | 活跃 Agent 执行预留；结束或失败后释放 |
| `agent.requests.daily` | 100 | `observe` / `day` | 每日 Agent 请求数 |
| `llm.total_tokens.monthly` | 2,000,000 | `observe` / `month` | Agent 与其他已接入模型链路的实际总 Token |
| `query_rewrite.llm.daily` | 200 | `observe` / `day` | 每日进入 LLM 问题改写的次数；纯确定性 preview 不计此项 |
| `quant.data_units.daily` | 2,000 | `observe` / `day` | 量化取数/策略任务的标准化数据工作量 |
| `research.report_runs.daily` | 20 | `observe` / `day` | 每日研究报告生成任务数 |
| `research.report_sends.daily` | 10 | `hard` / `day` | 每日真实研究报告推送数；dry-run 不计此项 |

可能产生资源消耗的操作先创建带 TTL 的 reservation，成功后按实际数量 settlement，将 `reserved` 转入 `used` 并写入 `usage_events`；失败或取消则 release。预留、结算和直接记账都要求唯一幂等键，同一键重复相同请求只返回原结果，用不同 actor、metric、项目或数量复用则返回 `409 QUOTA_IDEMPOTENCY_CONFLICT`。这避免客户端重试和 worker 重放造成重复扣量，并用数据库事务、advisory lock 与条件更新防止并发超卖。

`npm run prisma:deploy`（兼容别名 `prisma:push`）、Web 启动和 `db:init` 都先执行版本化 migration，再幂等补齐内置策略，并在接收流量前用 `projects.owner_id` 校准 `projects.owned` 全生命周期 bucket。校准与正常配额变更使用同一 actor/metric/window advisory lock；如果项目创建仍持有有效 reservation，该 actor 会被跳过，待下次启动重试，避免把“项目已插入但 reservation 尚未结算”的中间态重复计量。该精确校准只用于启动/管理员 bootstrap，不属于周期 cleanup；周期任务只回收过期 reservation。

管理员的用户级配额固定为无限，不能设置数值限制；这只是 enforcement 豁免，不是停止计量。管理员发起的已接入操作仍写入 bucket 和 `usage_events`，事件标记 `enforcement_exempt=true`，所以管理端可以看到真实 `used/reserved`，用于成本分析和异常检测。

启用认证后，入口会把 `user_requests.actor_user_id` 绑定到当前会话用户，后续物理 `agent_runs` 继承同一 actor，计量事件再关联 actor、project 和 source。相同 request ID 不能跨用户或跨项目重用。升级前的历史执行允许 actor 为空，不做猜测式追溯或补扣；删除用户后需要保留的 `usage_events` 会将 actor 置空。

## 权限与配额 API

| 路由 | 方法 | 权限 | 返回或修改内容 |
| --- | --- | --- | --- |
| `/api/admin/access-control` | `GET` | 管理员 | capability 目录、权限模板、配额模板和规则 |
| `/api/admin/users/[user_id]/access` | `GET` | 管理员 | 指定用户的有效权限、来源、模板、覆盖以及当前 `used/reserved/remaining` |
| `/api/admin/users/[user_id]/access` | `PATCH` | 新鲜管理员会话 | 原子更新模板和用户覆盖；需要 `reason` 与 `expectedAccessVersion` |
| `/api/account/usage` | `GET` | 当前登录用户 | 只读查看自己的有效权限、配额窗口和实际用量 |

`PATCH` 使用 `accessVersion` 做乐观并发控制：页面提交读取到的 `expectedAccessVersion`，成功后版本加一；若另一位管理员已经修改，接口返回 `409 ACCESS_POLICY_VERSION_CONFLICT`，客户端应刷新后重新确认，不能覆盖新策略。每次修改必须填写 3-500 字的原因，原因写入用户覆盖和 `admin.access_policy_updated` 安全审计；提交某类 override 数组表示整体替换该类用户覆盖。配额数量使用 PostgreSQL `BIGINT`，JSON API 统一返回十进制字符串，避免 JavaScript 精度损失。

## 运维与数据保留

定期清理过期认证数据，建议由部署环境每天执行：

```bash
npm run auth:cleanup -- --dry-run
npm run auth:cleanup
```

清理覆盖过期会话、过期验证记录、过期限流计数、超过保留期的安全审计，以及已到期但尚未 settlement/release 的 quota reservation。过期 reservation 会标记为 `expired` 并从 bucket 的 `reserved` 中归还，不会伪造实际用量；`--dry-run` 会同时报告待清理 reservation 数。默认审计保留 180 天，过期记录保留 1 小时宽限；可用 `QUANTPILOT_AUTH_AUDIT_RETENTION_DAYS` 和 `QUANTPILOT_AUTH_EXPIRED_RECORD_GRACE_SECONDS` 调整。`usage_events` 不属于该认证保留期清理范围。完整生命周期链路可在认证前后端已启动时运行 `npm run auth:verify`；脚本会创建临时用户和项目并在完成后恢复本机管理员状态。

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `QUANTPILOT_AUTH_MODE` | `disabled` | `disabled` 或 `local`；切换后必须重启 Web 进程。 |
| `QUANTPILOT_AUTH_SECRET` | 空 | 启用时必填，至少 32 字符；也兼容 `BETTER_AUTH_SECRET`。 |
| `BETTER_AUTH_URL` | 自动推断 | 生产环境建议显式设置认证服务根地址。 |
| `QUANTPILOT_AUTH_SECURE_COOKIES` | 生产为 `1` | HTTPS 环境必须启用 Secure Cookie。 |
| `QUANTPILOT_AUTH_TRUSTED_ORIGINS` | 空 | 逗号分隔的可信 HTTPS 来源；localhost 可使用 HTTP。 |
| `QUANTPILOT_AUTH_ALLOW_SIGNUP` | `0` | 是否开放自助注册；共享投研环境建议保持关闭。 |
| `QUANTPILOT_AUTH_SESSION_EXPIRES_SECONDS` | `43200` | 数据库会话绝对有效期。 |
| `QUANTPILOT_AUTH_SESSION_UPDATE_AGE_SECONDS` | `300` | 会话刷新间隔。 |
| `QUANTPILOT_AUTH_SESSION_FRESH_AGE_SECONDS` | `1800` | 敏感操作可使用的“新鲜会话”窗口。 |
| `QUANTPILOT_AUTH_REMEMBER_ME` | `0` | `0` 使用浏览器会话 Cookie；`1` 允许 Cookie 跨浏览器重启保留。 |
| `QUANTPILOT_AUTH_AUDIT_RETENTION_DAYS` | `180` | 安全审计保留天数，范围 30-3650。 |
| `QUANTPILOT_AUTH_EXPIRED_RECORD_GRACE_SECONDS` | `3600` | 过期会话、验证和限流记录删除前的宽限秒数。 |

结构化默认值和约束集中在 `config/auth.json`，环境变量只覆盖部署相关值。认证数据使用独立的 `auth_*` 表，不复用 Agent Runtime 的 `sessions` 表。正式部署还应把清理命令接入定时任务，并对连续登录失败、账号停用和管理员操作建立告警。

## 关闭与排障

紧急回退时将 `QUANTPILOT_AUTH_MODE=disabled` 并重启 Web 服务；认证表和账号不会被删除，再次启用后仍可使用。登录失败时按顺序检查：认证迁移状态、模式和 32 字符密钥、`BETTER_AUTH_URL`、浏览器是否使用正确协议、管理员是否已初始化。生产环境不要通过关闭 Secure Cookie、开放公开注册或绕过同源校验来修复配置问题。
