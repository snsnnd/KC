# 系统架构

## 运行组件

- Nginx 提供 `public/` 静态页面、HTTPS、`/api/` 反向代理和 `/uploads/` 文件访问。
- Node.js + Express 提供内容、申请、成员权限、邮件、库存、资金和审批 API。
- systemd 以 `www-data` 用户运行单个 Node.js 实例。
- `DATA_DIR` 保存 JSON 运行数据，`UPLOAD_DIR` 保存媒体文件。

## 持久化边界

当前持久化是纯文件方案，不是数据库。普通 JSON 通过临时文件写入后原子重命名；SMTP 授权码和受保护资源密码使用 `SESSION_SECRET` 派生的密钥进行 AES-256-GCM 加密。

库存、资金和申请审批共享进程内串行锁，保证单实例中不会重复审批或超额扣减。禁止在没有迁移到数据库事务的情况下启动多个 API 实例。

## 数据模型

- `content.json`：站点设置、项目、部门和资源。
- `applications.json`：加入申请，含姓名、学号、班级和联系方式。
- `members.json`：成员账号、基础资料和权限集合。
- `admins.json`：管理员账号和角色。
- `inventory.json`、`inventory-ledger.json`：物资与出入库流水。
- `funds.json`：资金账户与资金流水。
- `usage-requests.json`：材料和资金使用审批。
- `notifications.json`、`audit.json`：通知历史与审计记录。

## 数据库迁移时机

出现多实例、高并发写入、复杂统计查询、跨表事务或数据量显著增长时，优先迁移 PostgreSQL。迁移后应为项目分类、学号、申请状态和流水外键建立索引，并以数据库事务替换 `withResourceLock()`。
