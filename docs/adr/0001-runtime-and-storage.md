# 0001：首版运行时与存储选择

状态：用于初步 MVP；生产上线仍须完成验证记录中的门槛。

Web 使用 React/Vite，API 使用 Nest，Bridge 使用 Node/TypeScript，与 contracts/domain 共享协议与纯规则。首版只有 API 内部串行调度，不引入独立 worker、Redis 或 LangGraph 来制造第二套权威状态。

默认 Agent 实现为锁定版本 Pi 1.3.0 RPC。平台自己提供文件工具、签名授权、执行账本、租约、进程终结和事件恢复，Pi 只负责模型与工具循环。受控扩展在 provider 请求前执行预算检查；RPC 的 agent_settled 表示模型循环稳定，仍须实际终结进程后才能上报结果。

另提供明确标识的 inspection 适配器，方便没有凭据时检查真实协作与 worktree 链路。它不能替代 AI 代码分析验收。

生产使用 PostgreSQL；本机开发默认使用 PGlite，方便直接启动且保留数据。两者共用 SQL schema 与事务接口，但 PGlite 测试不能证明 PostgreSQL 多连接竞争与生产性能。迁移追加发布，记录 SHA-256，禁止修改已应用且已有校验值的迁移。最早未记录校验的本地原型库仅在升级时登记一次基线。

MVP 使用本地 SQLite 管理设备尝试与未确认事件。未知执行的槽位不自动释放，暂不做自动孤儿进程恢复；PID 检查和人工证明的局限须在运行手册中写明。
