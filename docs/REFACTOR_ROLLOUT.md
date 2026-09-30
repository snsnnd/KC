# 管理端与展示端分离上线顺序

本次分离只改变静态发布边界，不迁移业务数据，不启动第二个 API 实例。展示端与管理端继续使用同一 Origin、单个 Node.js 进程、`/var/lib/tech-club` 和 `/var/lib/tech-club/uploads`。

## 上线前门禁

1. 在维护窗口执行现有备份 service，记录归档路径、SHA-256、大小和时间。
2. 检查归档包含 `/var/lib/tech-club/*.json`、实际上传文件及 `/etc/tech-club-cms.env`。
3. 在隔离目录完成一次解包和加密 envelope 检查。没有成功备份和恢复验证时停止上线。
4. 不对生产加密目录运行当前 `migrate-data.mjs`，不复制、清空或重建任何 JSON。
5. 运行后端测试、`sh -n deploy/scripts/deploy-frontend.sh` 和 `nginx -t`。

## 首次切换

先准备两套静态 `current`，再安装新的 Nginx 路由：

```bash
DOMAIN=www.jtkczx.xyz deploy/scripts/deploy-frontend.sh public showcase <release-id>
DOMAIN=www.jtkczx.xyz deploy/scripts/deploy-frontend.sh public control <release-id>
```

渲染 `deploy/nginx/tech-club.conf` 中的 `example.com` 为证书实际绑定域名，保存旧配置后执行：

```bash
nginx -t
systemctl reload nginx
curl --fail --silent "https://$DOMAIN/" >/dev/null
curl --fail --silent "https://$DOMAIN/admin.html" >/dev/null
curl --fail --silent "https://$DOMAIN/api/health"
```

人工验证展示首页、加入申请、成员登录、管理登录、一次内容保存和一次测试媒体上传。静态切换不重启 API，不读取或写入数据目录。

## 后续独立发布

- 展示端：`deploy-frontend.sh public showcase <release-id>`
- 管理端：`deploy-frontend.sh public control <release-id>`
- 两个发布面分别维护 `releases/` 和 `current`，冒烟失败只回滚当前发布面。
- API、数据格式或 systemd 有变化时不属于普通前端发布，必须重新进入维护窗口和数据备份流程。

## 回滚

展示端或管理端回滚只切换对应静态 `current`。不得用静态回滚命令覆盖 `/var/lib/tech-club`。只有后端版本或数据格式确实发生不兼容变化时，才按已演练的完整备份恢复流程停服务并恢复数据。

## 明确禁止

- 禁止让“展示 API”和“管理 API”两个进程共享当前 JSON 数据目录。
- 禁止把备份、环境文件或业务 JSON 放进任一 Web 根目录。
- 禁止在未确认域名和证书名称时直接安装模板中的 `example.com`。
- 禁止将用户提供的服务器密码写入仓库、命令历史、文档或日志。
