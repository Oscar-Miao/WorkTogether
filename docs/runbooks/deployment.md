# 部署、备份恢复和回退

## 本机开发与构建后运行

在 demo 根目录安装依赖、pnpm run setup、pnpm dev。构建后可 pnpm build、pnpm start；开发模式访问地址须与 .env.local 中 WEB_ORIGIN 一致，例如将其改成 http://127.0.0.1:3001 后用打包 API 同时提供 Web。改变地址后重启服务并重新登录。

本机默认 PGlite，仅供开发。当前本地 SQL、权限与协议测试使用此存储，不能据此认定 PostgreSQL 的生产部署、竞争行为和性能已通过。

## 云端部署模板

infra/compose/compose.yaml 提供 PostgreSQL、API/Web、Caddy 反向代理。Bridge 留在 Owner 本机，云端不配置模型 key。该模板尚未在本环境启动验证，Docker 引擎当前未运行。

1. 配置域名 DNS 与目标机器，使 APP_DOMAIN 的 80/443 可达。
2. 将 infra/compose/.env.example 复制成同目录被忽略的 .env，设置域名、Owner 邮箱及两份独立强密码。PostgreSQL 密码使用足够长的 base64url 字符串，避免 URL 保留字符造成连接串解析错误。
3. 在 demo 根执行：

```powershell
docker compose -f infra/compose/compose.yaml --env-file infra/compose/.env up --build -d
```

4. 验证 HTTPS 登录、Cookie Secure、WSS 设备连接及 SSE；数据库不映射公网端口。
5. 检查持久卷权限、磁盘配额和备份后，使用真实远端成员做跨机验证。没有完成这些步骤，不标记可上线。

NODE_ENV=production 强制 DATABASE_URL、HTTPS WEB_ORIGIN 和绝对 TEAM_AGENT_SERVER_DATA_DIR。容器以 node 用户运行，数据根与源码分开；容器化云端不代表 Owner 本机执行已获得沙箱隔离。

## 备份与恢复

发布目标是每日备份、RPO ≤24h、RTO ≤4h，当前尚未实测达到。

备份 PostgreSQL 的一致性快照、server 私有数据根及许可签名密钥，备份进入独立受控位置。Owner 设备另外备份其配对身份、SQLite/WAL 和未确认输出；模型凭据按 Owner 的本机凭据策略保存。备份含秘密，不能放代码仓库或公开对象存储。

恢复演练应使用新目录/新数据库并隔离设备连接：

1. 恢复匹配版本的数据库、文件和签名密钥，检查迁移校验。
2. 启动 API，所有恢复出来的活动尝试先进入 RECONCILING。
3. 让原设备回连并核对 ledger；仍在运行的受管句柄可重新关联，无法确认的保持锁定。
4. 只有确认停止并有证据后才释放槽位。验证未确认事件补传、旧审批不会扩大权限、Owner 未发布成果对成员仍不可见。
5. 记录恢复用时、可恢复时间点和核查结果；当前尚未完成该演练。

本机 PGlite 做冷备份时，先停止唯一 API，再备份完整数据目录，不能只复制某个内部文件。测试和日常服务使用不同目录。

## 版本回退

保存构建版本、pnpm-lock.yaml、已应用迁移版本、数据库与私有数据备份。已应用迁移必须追加演进，校验不符会拒绝启动。回退代码前核对 schema 兼容性；需要恢复旧数据时先停写，恢复到隔离环境验证后再切换。不要通过删除迁移记录或把活动任务改为 QUEUED 完成回退。
