# PGlite 数据查看与账号操作手册
内测版 | 共域 Team Agent | 2026-10-20

本手册说明如何查看账号、团队、群聊与执行记录，以及内测密码规则和改密流程。文中的邮箱、密码和 ID 均为合成示例，不是你的真实凭据。

## 01 数据库密码与快速开始

| 项目 | 当前情况 |
| --- | --- |
| 本地服务数据库 | PGlite，嵌入 API 进程并持久化到目录 |
| 数据库用户名 / 密码 | **无需填写**；当前没有数据库登录凭据 |
| 数据库网络端口 | 未开启；3001 是 API 端口，5173 是 Web 页面端口 |
| 应用账号密码 | 登录共域时使用；users 表保存 Argon2id 哈希 |
| 根库默认位置 | E:\项目实践2\demo\.local\server\postgres |
| 查看方式 | 项目自带 pnpm db:inspect，只读 SQL |

### 三步打开数据
1. 在运行 pnpm dev 的终端按 Ctrl+C，等待开发进程退出。API 和查看器不能同时打开同一份库。
2. 打开 PowerShell，切换到工程并启动查看器：

```powershell
Set-Location -LiteralPath 'E:\项目实践2\demo'
pnpm db:inspect
```

3. 看到 PGlite> 后输入查询：

```sql
SELECT id, email, name, role FROM users LIMIT 20;
```

PGlite 没有本工程可填写的数据库连接密码；共域账号密码、维护账号的本机初始化凭据，也不能当作数据库连接密码。

资料：工程 scripts/database/inspect.ts；PGlite 文件系统文档 https://pglite.dev/docs/filesystems；PostgreSQL 只读事务说明 https://www.postgresql.org/docs/18/sql-set-transaction.html。

<!-- pagebreak -->
## 02 根库：账号、团队和项目

工具读取 .env.local / 当前环境中的服务数据目录设置。未修改配置时，根库位于 .local/server/postgres。根库保存全站身份、团队目录，也兼存默认项目的历史业务。

### 查看器快捷命令

| 在 PGlite> 中输入 | 作用 |
| --- | --- |
| \tables | 列出当前库的数据表 |
| \describe users | 查看 users 表的字段及类型 |
| \projects | 列出团队、项目名称和项目 ID |
| \help | 查看帮助 |
| \q | 退出并释放数据库锁 |

这些是本项目查看器的快捷命令，不是 SQL，也不是系统自带的 psql。SQL 每次一行一条，末尾分号可选。

### 常用查询
查看账号资料，不输出密码哈希：

```sql
SELECT id, email, name, role, active FROM users LIMIT 20;
```

按邮箱查找账号；把示例邮箱换成注册时填写的值：

```sql
SELECT id, email, name FROM users WHERE email='demo@example.test';
```

查看团队、项目和显式项目成员关系：

```sql
SELECT id, name FROM org_workspaces;
SELECT id, name, workspace_id FROM org_projects;
SELECT project_id, user_id, role FROM org_project_members LIMIT 20;
```

上面代码块包含三条示例，请逐条输入，不要一次粘贴三条语句。password_hash 不能用于还原用户密码。

<!-- pagebreak -->
## 03 项目库：群聊、消息和任务

先在根库执行 \projects，记下目标项目的真实 ID。执行 \q 退出根库后，再打开目标项目；prj_xxx 是占位符，需要替换。

```powershell
pnpm db:inspect -- --project prj_xxx
```

| 范围 | 默认目录 / 内容 |
| --- | --- |
| 根库 | .local/server/postgres：身份、团队目录、默认项目历史 |
| 新建项目库 | .local/server/projects/prj_xxx/postgres：该项目业务 |
| Bridge 账本 | .local/bridge/.../state/ledger.sqlite：本机执行记录 |

### 在项目库中逐条查询
群聊与最近消息，正文先截取前 80 个字符：

```sql
SELECT id, title, visibility FROM conversations LIMIT 20;
SELECT seq, left(body,80) AS body FROM messages ORDER BY created_at DESC LIMIT 20;
```

协作目标、执行任务和执行尝试：

```sql
SELECT id, title, state, decision FROM collaboration_goals LIMIT 20;
SELECT id, state, creator_id FROM tasks ORDER BY created_at DESC LIMIT 20;
SELECT id, task_id, status FROM execution_attempts LIMIT 20;
```

成果与资料版本：

```sql
SELECT id, title, kind, published FROM artifacts LIMIT 20;
SELECT id, name, current_version FROM sources LIMIT 20;
```

看不到新项目的消息时，先检查是否打开了正确项目库。项目库同步所需人员资料，不复制真实登录密码；PROJECT_IDENTITY_ONLY 是占位值，不是登录密码。

<!-- pagebreak -->
## 04 内测账号与修改密码

| 项目 | 规则 |
| --- | --- |
| 内测注册 / 邀请开户 / 改密 | 至少 6 位，最多 200 位；允许纯数字，例如合成示例 123456 |
| 生产模式 | NODE_ENV=production 时，新注册、邀请开户和改密恢复至少 12 位 |
| 邮箱 | 只检查格式，例如 demo@example.test；不验证真实存在 |
| 密码保存 | 仍使用随机盐和 Argon2id；放宽长度不改变哈希算法 |
| 改密凭据 | 邮箱 + 当前密码 + 新密码 + 确认新密码 |

### 登录页修改密码
1. 打开 Web 登录页，点击登录表单下的“修改密码”。已登录时可以先退出账号。
2. 填写邮箱、当前密码、新密码及确认新密码。两次新密码必须一致。
3. 点击“确认修改密码”。成功后返回登录表单，使用新密码重新登录。
4. 该账号的全部旧登录会话会失效，其他账号不受影响。

当前提供的是知道旧密码时的修改流程，没有仅凭邮箱重置密码的入口，也没有邮箱验证码和自助找回密码。

### 忘记初始化维护账号密码
已有本机恢复命令会修改维护账号密码。确需恢复时，先停止 API，再执行：

```powershell
pnpm reset:owner
```

新凭据写入服务数据根目录下 private/owner-recovery.json。普通成员没有对应的自助恢复命令；查看器也拒绝直接 UPDATE 密码字段。

生产门槛只约束新设置的密码，不会自动把历史短密码变强。正式部署前应让内测账号完成改密，或启用独立的正式账号集合。

<!-- pagebreak -->
## 05 SQL 速查与故障处理

| SQL 片段 | 作用 |
| --- | --- |
| SELECT 指定列 FROM 表 | 读取指定字段 |
| WHERE state='RUNNING' | 按条件筛选 |
| ORDER BY created_at DESC | 新记录排在前面 |
| LIMIT 20 | 限制查询条数 |
| SELECT count(*) FROM users | 统计账号数量 |

查询一次后立即退出：

```powershell
pnpm db:inspect -- --sql 'SELECT count(*) FROM users;'
```

指定另一份服务数据根目录，传 server 这一层，不要再加 postgres：

```powershell
pnpm db:inspect -- --data-dir 'E:\项目实践2\demo\.local\server'
```

| 遇到的情况 | 处理 |
| --- | --- |
| 数据库正在使用 / LOCAL_DATABASE_IN_USE | 先停止 API 或另一查看器；不要手工删除锁文件 |
| 数据库目录不存在 | 检查 data-dir 和项目 ID；工具不会新建空库 |
| 查询结果为空 | 检查根库 / 项目库是否选对，再检查筛选条件 |
| read-only / 写操作被拒绝 | 本工具只读；通过产品页面修改业务数据 |
| 当前配置为 PostgreSQL | 使用对应客户端及自行配置的凭据；本命令只支持 PGlite |

### 退出、备份与恢复页面
在 PGlite> 输入 \q 后运行 pnpm dev，可恢复 Web 与 API。查看期间 API 已停止，页面无法加载是预期行为。

需要备份时，先退出查看器，并保持 API 停止，再复制完整服务目录：

```powershell
$backupRoot = '.local\backups'
New-Item -ItemType Directory -Force $backupRoot
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$target = Join-Path $backupRoot ('server_' + $stamp)
Copy-Item -LiteralPath '.local\server' -Destination $target -Recurse
pnpm dev
```

