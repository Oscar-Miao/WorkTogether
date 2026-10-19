# Project rules

- 唯一代码工程根：E:\项目实践2\demo。所有源码、测试、脚本和工程配置都在本目录内。
- 需求基线：[MVP 需求](../01_MVP需求文档.md)（v2.0）；当前实现边界见 docs/qa/implementation-status.md；进阶说明：[进阶需求](../02_进阶版需求文档.md)。
- apps/web 是浏览器应用；apps/api 管主节点协调与业务事实；apps/bridge 管本机执行。禁止跨应用导入。
- 正式群聊前端入口为 apps/web/src/app/App.tsx 与 apps/web/src/features/chat；旧 tasks/sources/memories 页面组件暂留兼容，不是新版主要入口。父目录原型仅供交互评审。
- 共享协议放 packages/contracts；纯规则放 packages/domain；运行时适配器放 packages/agent-runtime。
- 已获授权在现有基础上搭建进阶版，按 P1/P2/P3 递进；授权不得依靠提示词，取消不得伪装回滚，未知执行不得盲目重派。
- 多项目事实使用独立数据库 schema/PGlite 目录，身份与项目成员关系留在根控制面；任何新接口都须覆盖跨项目与私群隔离。
- 注释使用中文，解释授权、不变量、竞态、恢复、平台差异和跨模块调用；公开接口及不直观分支应有适量说明，避免逐行复述代码。
- 工具 label、description、参数 description 及面向用户的说明使用中文；协议字段、稳定工具名和机器错误码保持兼容。
- Pi 扩展入口只做组装；工具按能力目录拆分，统一清单位于 packages/agent-runtime/src/adapters/pi/tool-policy.ts。新增工具必须补齐显式注册、授权边界及对应验证。
- 生成数据只能进入 .local，秘密不可提交；演示运行时必须明确标识，不冒充真实模型调用。
- 核心检查：pnpm check、pnpm check:structure、pnpm test、pnpm build。变更核心链路后执行集成/E2E。
