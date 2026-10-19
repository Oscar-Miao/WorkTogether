# 共域 · Team Agent 进阶基础版

团队在同一个群聊 Web 界面讨论、认领和委托 Agent。主协调 Agent 比较已登记的人工／Agent 工作，在主设备预设策略内批准推进、拒绝重复启动或停止既有执行。Owner 是主服务器设备；人类维护者配置能力和预算，成员可纠正判断、复核或请求停止。源码基线见 [MVP 需求](../01_MVP需求文档.md)，进阶能力见 [后续需求](../02_进阶版需求文档.md)。

现有工程已接入多空间/项目、群生命周期、目标依赖与交接、讨论分叉、版本修订、多 Runner 只读 DAG、OIDC 和治理侧栏。当前为可运行的进阶基础版本；逐项覆盖和企业待验收项见 [进阶交付状态](docs/qa/advanced-status.md)，入口和权限机制见 [进阶运行指南](docs/architecture/advanced-collaboration.md)。所有代码、脚本、测试、配置继续保留在本 demo 工程中。

## 本地启动

要求 Node.js 24+、pnpm 11.25.0、Git。首次使用且终端提示找不到 pnpm 时，在 PowerShell 执行：

```powershell
npm.cmd install --global pnpm@11.25.0
pnpm --version
```

版本应输出 11.25.0。以下命令在 **E:\\项目实践2\\demo** 执行：

```powershell
pnpm install --frozen-lockfile
pnpm run setup
pnpm dev
```

打开 http://127.0.0.1:5173 。首次初始化会生成本机密码，登录凭据位于 **.local/server/bootstrap-owner.json**，不要提交或发送该文件。重复执行 pnpm run setup 不重置已有维护者密码。OWNER_EMAIL / OWNER_PASSWORD 和数据库 OWNER 角色名保留初始化兼容，界面将该人类角色称为项目维护者。开发 API 位于 127.0.0.1:3001。

忘记 Owner 密码时，先停止 API，再以服务运行身份执行 pnpm reset:owner。新凭据写入数据根下 private/owner-recovery.json，所有旧 Owner 会话失效，并留下审计。命令不向终端输出密码；本地数据库锁会拒绝和 API 同时打开 PGlite。

未配置 DATABASE_URL 时使用持久化 PGlite，数据保存在 .local/server/postgres。它适合本机开发；生产模式强制使用外部 PostgreSQL、HTTPS Web 地址及源码之外的绝对持久目录。

## 进入进阶功能

启动后打开主设备侧栏，展开“空间、项目与成员范围”创建项目。存在多个项目时标题旁提供唯一切换入口。群成员侧栏提供分叉、归档和管理移交；目标详情提供依赖、交接、修订与只读分工计划。默认设备与并发配额仍为 1，维护者显式保存新配额后再配对其他 Runner。

组织登录需要配置 OIDC 发行者与客户端；真实 Pi 模型仍由本机 Bridge 配置。完整步骤见 [进阶运行指南](docs/architecture/advanced-collaboration.md)。

## 完成第一个协作闭环

1. 在群列表“＋”创建或加入群聊。“我来做 …”会形成候选，确认“我来做”后登记人工负责；后续同范围委托会关联既有工作。
2. 准备主设备允许使用、至少有一次提交的 Git 仓库；在同页“主设备状态”生成配对码，在主设备终端运行下列命令。
3. 设备连接后，在同一侧栏的“主设备执行策略”选择仓库并保存“启用明确委托后的自动执行”。默认关闭自动执行；初次建议只开放只读能力。
4. 回到群聊输入“@AI 分析项目结构并列出风险清单”。Agent 先比对，再按策略排队；无需填写任务表单或进入人工审批台。
5. 查看群内协作卡、“查看依据”中的真实报告／上下文，或在原卡复核、停止。明确停止也可发送“@AI 停止 完整目标标题”。
6. 资料、群成员、目标与设备均在同一页面。左栏上下文／资料只有一个合并开关，群聊按钮始终高亮。

```powershell
pnpm bridge -- --pair YOUR_PAIRING_CODE --repo "D:/your-git-repo" --runtime inspection
```

inspection 是明确标识的确定性只读文件检查，**不调用 AI**，用于无模型凭据时验证链路。后续直接 pnpm bridge 重连；每个 Bridge 数据目录只允许一个执行实例。

## 配置目标理解模型

不配置模型时，顶部明确显示“规则观察模式”，仅处理明确认领／委托、精确重复与保守澄清。它能验证真实协作和执行链，不能代表完整语义理解。

如需开启模型理解，在运行 API 的主设备环境配置以下变量并重启 pnpm dev。填写你实际可用的模型 ID；凭据只存于主设备私有环境，不提交到仓库或上传浏览器。

```powershell
$env:COORDINATOR_ENABLED = "true"
$env:COORDINATOR_BASE_URL = "https://api.deepseek.com"
$env:COORDINATOR_MODEL = "YOUR_MODEL_ID"
$env:COORDINATOR_API_KEY = "YOUR_LOCAL_API_KEY"
pnpm dev
```

此端口接受 OpenAI 兼容 chat/completions JSON 协议。目标理解与执行是两个角色：配置协调器模型不会自动配置 Pi 执行模型，也不会自动开启设备策略。真实供应商、语义质量和长期可靠性仍需按 [验证状态](docs/qa/implementation-status.md) 完成评测。

## 接入真实 Pi 和模型

Pi 1.3.0 已锁定在工程依赖中，Bridge 以结构化 RPC 驱动实际 Pi 进程。模型凭据只在 Owner 本机配置，不通过网页上传。

对 Pi 内置提供商，在 Bridge 终端设置 PI_PROVIDER、PI_MODEL 和对应 API key 环境变量。模型 ID 必须是该提供商实际提供且当前账号可访问的值；工程不会替你购买额度。

企业 OpenAI 兼容端点可参考 [模型配置样例](infra/deploy/models.example.json)，在 .local 下建立自己的私有配置，并设置：

```powershell
$env:TEAM_AGENT_MODEL_CONFIG = (Resolve-Path ".local/models.json").Path
$env:PI_PROVIDER = "enterprise"
$env:PI_MODEL = "YOUR_MODEL_ID"
$env:PI_PROVIDER_API_KEY = "YOUR_LOCAL_API_KEY"
pnpm bridge -- --pair YOUR_PAIRING_CODE --repo "D:/your-git-repo" --runtime pi --allow-edit src,tests --data-dir ".local/bridge/pi-device"
```

切换 runtime 或放宽目录前，先在网页撤销旧设备并核清其任务，再为新目录配对。不要修改活动设备配置来扩大既有审批。--allow-edit 仅开放对既有文件的精确替换；不开 Shell、新建/删除文件、提交、推送或任意测试命令。

每次执行使用独立 Pi home，只装载平台受控工具，忽略仓库中的扩展、MCP、技能和上下文指令文件。企业模型配置不允许 !command 形式的凭证命令。工具边界不构成操作系统沙箱，只适用于可信团队和 Owner 允许的仓库。

## 历史资料与保留

底层会话、任务、资料、结论和审计的 cursor 分页接口继续保留。新版群聊已接入消息历史、完整资料读取与带版本编辑；其他长列表和记忆治理界面仍在重构中。既有数据保留预览、保护标记和清理接口保留并补齐群权限，旧任务详情组件暂留兼容，尚未作为新主界面的治理入口。

云端清理执行默认关闭（TEAM_AGENT_RETENTION_ENABLED=false）。代码已提供到期批处理、提前清理、保留保护和缺失证据标记；本次仅在全新合成库启用测试，没有开启现有数据清理。本机事件、结果和 worktree 继续保留，维护边界见 [Bridge 手册](docs/runbooks/bridge-recovery.md) 和 [验证记录](docs/qa/implementation-status.md)。

## 代码阅读与客户体验

Pi 的扩展位置、工具注册、模型调用、真实文件操作及新增工具步骤见 [Pi 工具调用链](docs/architecture/pi-tool-chain.md)。工具按能力拆分，中文描述和参数说明随各工具维护。

以客户身份体验时，先按 [客户试用方案](docs/qa/customer-pilot.md) 创建独立试用库，用三个独立浏览器会话验证协作，再邀请真实小组。跨机器体验需准备 HTTPS 入口，当前前端使用的 crypto.randomUUID 依赖安全上下文，普通局域网 HTTP 不作为完整体验方案。

## 工程导航

| 位置                   | 内容                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| apps/web/src/features  | 单页群聊、提及、协作卡、复核／停止、统一侧栏、资料与设备           |
| apps/api/src/modules   | 群成员、持久观察、目标协调、身份、版本上下文、执行事实、网关、审计 |
| apps/bridge/src        | 本机配对、单实例锁、SQLite 账本、租约、worktree、结果补传          |
| packages/contracts     | HTTP / WebSocket schema、DTO、错误协议                             |
| packages/domain        | 状态机、审批指纹、保留来源的历史摘录                               |
| packages/database      | PostgreSQL/PGlite 接入、追加迁移、迁移校验                         |
| packages/agent-runtime | Pi RPC、受控文件工具、只读检查适配器                               |
| tests                  | 集成、协议、浏览器验证；单元测试与源码相邻                         |
| scripts                | 初始化、开发启动、目录/依赖检查                                    |
| docs                   | 架构、决策、运行手册、验证记录                                     |
| infra                  | 云端部署和本机模型配置模板                                         |
| .local                 | 被忽略的私有数据、账本、任务目录、报告和截图                       |

目录名称与运行数据的授权范围是不同概念；数据库保存工作空间、项目、会话和权限事实。不要把上传文件放 apps/web/public，也不要把任务 worktree 当作平台源码入口。

## 检查和构建

```powershell
pnpm check
pnpm check:structure
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
pnpm check:smoke
```

测试使用独立的 .local/reports 子目录和合成账号；浏览器测试占用 3002/4173，日常开发占用 3001/5173。Pi 协议测试会启动真实 Pi CLI 和本地模拟模型服务，验证读写、越权拦截和预算，不代表真实商业模型质量评测。

pnpm build 输出 apps/api/dist 和 apps/web/dist；pnpm start 启动打包 API 并提供构建后的 Web 静态文件。访问地址要与 WEB_ORIGIN 一致。生产部署参考 [部署与恢复](docs/runbooks/deployment.md)，异常核查参考 [Bridge 手册](docs/runbooks/bridge-recovery.md)。

## 当前边界

支持多空间、多项目和项目独立设备，默认沿用旧项目的 10 名成员、1 台活动设备和 1 并发。成员上限可配置为 1～500；执行配额由项目维护者显式调整。只读 DAG 可并行，代码写入按项目代码资源排他。工具仍支持真实读取和获准既有文件的精确编辑；自动 Git 合并、新建/删除文件、Shell 与测试命令未开放，报告保持真实验证状态。

Owner 私有资料不能隐式加入共享任务。候选记忆需 Owner 确认后显式引用；资料改版或记忆失效使旧审批不可执行。自动摘录保留原文 ID，省略部分可通过受任务许可约束的回读恢复，摘要不授予权限。

未验证的真实模型、跨机器网络、PostgreSQL 部署、备份恢复和多日试用都在验证记录中明确列出；本机测试通过不代表已达到全部上线指标。
