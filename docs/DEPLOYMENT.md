# 生产部署与备份

本文档中的命令必须由获授权的运维人员在生产主机执行。仓库配置只是模板，提交配置不代表已经上线。本轮仅对生产故障创建缺失的空数据文件以恢复 API；此处描述的完整发布尚未执行。

## 固定路径与限制

生产模板固定使用以下路径：

- API 程序：`/opt/tech-club-cms`
- 静态站点版本：`/var/www/tech-club/releases/<release-id>`
- 当前静态站点：`/var/www/tech-club/current`
- ACME 验证目录：`/var/www/tech-club-acme`
- 数据目录：`/var/lib/tech-club`
- 上传目录：`/var/lib/tech-club/uploads`
- 环境文件：`/etc/tech-club-cms.env`
- 本机备份：`/var/backups/tech-club`

不要只修改 `DATA_DIR` 或 `UPLOAD_DIR`。Nginx alias、systemd `StateDirectory`、`ReadWritePaths` 和备份脚本均按上述固定路径设计；如需迁移路径，必须同步修改、审查和测试全部组件。

端到端请求体限制分两层：Nginx 对普通请求限制为 `2 MiB`，Express JSON 解析器进一步限制 JSON 请求体为 `1 MiB`。只有精确路径 `/api/admin/upload` 在 Nginx 放宽到 `101 MiB`，应用层 Multer 仍限制单文件为 `100 MiB`。

## 部署前确认

1. 先完成一次可恢复备份，记录归档文件名、SHA-256、执行时间和恢复演练结果。
2. 确认发布包、静态文件和待部署版本，不要把整个仓库放进 Web 根目录。
3. 确认所有生产 JSON 都是可解密的 AES-256-GCM envelope，并确认 `project-workspaces.json` 的初始化或迁移方案。
4. 确认生产 `SESSION_SECRET` 是固定 64 位十六进制值，并设置 `DATA_ENCRYPTION=true`；生产模式会拒绝其他格式，并同时要求 HTTPS `PUBLIC_BASE_URL` 与 `COOKIE_SECURE=true`。非生产环境仍只要求密钥至少 32 字符。
5. 确认 `TRUST_PROXY_HOPS=1` 与当前“客户端 -> 本机 Nginx -> Node.js”的单层可信代理拓扑一致。
6. 首次初始化可临时配置至少 12 字符的 `ADMIN_PASSWORD`；确认 `admins.json` 创建成功后，从环境文件删除该变量并重启服务。
7. 确认待部署后端包含 SIGTERM 优雅退出：停止接收新请求，等待在途请求以及写队列完成后退出，并在 `TimeoutStopSec=30s` 内完成测试。
8. 使用 `nginx -t` 和 `systemd-analyze verify` 检查安装后的最终文件，再进入维护窗口。

生产 API 以受 systemd 强沙箱限制的 `root` 身份运行，使加密数据文件可保持 `root:root 0600`。上传目录必须保持可遍历，公开上传文件由应用显式设为 `0644`；不要放宽 JSON 数据文件权限。

## 安装环境文件

先备份已有环境文件；不存在时才安全创建空文件。不要用 `install /dev/null` 覆盖现有配置。

```bash
umask 077
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
if test -e /etc/tech-club-cms.env; then
    cp -a /etc/tech-club-cms.env "/etc/tech-club-cms.env.before-${STAMP}"
else
    install -o root -g root -m 0600 /dev/null /etc/tech-club-cms.env
fi
editor /etc/tech-club-cms.env
chown root:root /etc/tech-club-cms.env
chmod 0600 /etc/tech-club-cms.env
grep -Eq '^SESSION_SECRET=[0-9a-fA-F]{64}$' /etc/tech-club-cms.env
grep -Fx 'DATA_DIR=/var/lib/tech-club' /etc/tech-club-cms.env
grep -Fx 'UPLOAD_DIR=/var/lib/tech-club/uploads' /etc/tech-club-cms.env
grep -Fx 'TRUST_PROXY_HOPS=1' /etc/tech-club-cms.env
grep -Fx 'DATA_ENCRYPTION=true' /etc/tech-club-cms.env
```

环境文件必须是 `root:root 0600` 的普通文件，不能是符号链接。备份脚本会在停服务前检查这些条件，不满足时直接失败且不生成归档。

## 安装 CMS 与 Nginx

先分别备份现有 unit、站点文件和启用链接，再渲染实际域名或证书绑定 IP。不得原样安装包含 `example.com` 的模板：

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ROLLBACK_DIR="/root/tech-club-deploy-rollback-${STAMP}"
DOMAIN="47.120.0.45"  # 必须按实际证书名称确认
case "$DOMAIN" in (*[!A-Za-z0-9.-]*|'') exit 1;; esac
install -d -o root -g root -m 0700 "$ROLLBACK_DIR"
test ! -e /etc/systemd/system/tech-club-cms.service || cp -a /etc/systemd/system/tech-club-cms.service "/etc/systemd/system/tech-club-cms.service.before-${STAMP}"
test ! -e /etc/nginx/sites-available/tech-club.conf || cp -a /etc/nginx/sites-available/tech-club.conf "/etc/nginx/sites-available/tech-club.conf.before-${STAMP}"
test ! -e /etc/nginx/sites-enabled/tech-club.conf || cp -a --no-dereference /etc/nginx/sites-enabled/tech-club.conf "$ROLLBACK_DIR/sites-enabled-tech-club.conf"
install -o root -g root -m 0644 deploy/systemd/tech-club-cms.service /etc/systemd/system/tech-club-cms.service
test -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
test -s "/etc/letsencrypt/live/$DOMAIN/privkey.pem"
sed "s/example\.com/$DOMAIN/g" deploy/nginx/tech-club.conf > "$ROLLBACK_DIR/tech-club.conf.rendered"
! grep -q 'example\.com' "$ROLLBACK_DIR/tech-club.conf.rendered"
install -o root -g root -m 0644 "$ROLLBACK_DIR/tech-club.conf.rendered" /etc/nginx/sites-available/tech-club.conf
```

模板自带 80/443 `default_server`。如果 `/etc/nginx/sites-enabled/default` 或其他站点也声明默认站点，会发生冲突。必须先执行 `nginx -T` 核对该站点是否承载其他业务，并备份到上一步的 `$ROLLBACK_DIR`；只有确认它是可停用的发行版默认页后，才可解除链接，不能盲删文件。不要把备份副本留在 `sites-enabled`，否则通配 include 仍可能加载它。

```bash
: "${ROLLBACK_DIR:?先执行上一段命令并保留同一 root shell}"
nginx -T
test ! -e /etc/nginx/sites-enabled/default || cp -a --no-dereference /etc/nginx/sites-enabled/default "$ROLLBACK_DIR/sites-enabled-default"
# 仅在人工确认 default 不承载业务后执行下一行：
unlink /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/tech-club.conf /etc/nginx/sites-enabled/tech-club.conf
nginx -t
systemctl reload nginx
```

Nginx 验证并重载成功后，再加载和启动 CMS：

```bash
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/tech-club-cms.service
systemctl enable tech-club-cms.service
systemctl restart tech-club-cms.service
systemctl is-active --quiet tech-club-cms.service
: "${DOMAIN:?请在当前 shell 设置并核对 DOMAIN}"
curl --fail --silent "https://$DOMAIN/api/health"
```

`StateDirectory=tech-club` 创建 `/var/lib/tech-club`，`UMask=0077` 约束新文件。业务 JSON 使用 AES-256-GCM 加密并保持 `root:root 0600`；密钥来自 root-only 环境文件中的 `SESSION_SECRET`。历史文件不会因 unit 更新自动迁移，必须先备份再完成加密迁移。

## 独立发布前端

前端与 API 使用同一公网 Origin，但发布产物完全独立。前端仍通过根相对路径访问 `/api/` 和 `/uploads/`，因此不需要 CORS，也不能把静态页面直接迁到另一个域名。

```bash
install -o root -g root -m 0755 deploy/scripts/deploy-frontend.sh /usr/local/sbin/deploy-tech-club-frontend
DOMAIN=www.jtkczx.xyz /usr/local/sbin/deploy-tech-club-frontend /path/to/public 20260724T120000Z
```

脚本将文件复制到新版本目录，校验必要入口，原子切换 `/var/www/tech-club/current`，并检查首页和 `/api/health`。普通前端发布不执行 `systemctl restart tech-club-cms`。后端邮件依赖 `/activate.html`、`/email-approval.html`、`/member.html` 和 `/admin.html` 等稳定路径，前端升级不得直接删除这些入口。

root 查看加密数据使用：

```bash
tech-club-data list
tech-club-data read admins.json
systemctl stop tech-club-cms.service
tech-club-data write admins.json /root/admins.edited.json
systemctl start tech-club-cms.service
```

## 部署回滚

发布前应记录所有 `.before-时间戳` 文件。应用或健康检查失败时：

1. 停止 CMS，保留失败版本日志，不要在服务运行时覆盖 JSON。
2. 恢复上一版 `/opt/tech-club-cms`、systemd unit 和环境文件；若数据格式已迁移，按已演练的备份恢复流程回退数据。
3. 恢复上一版 Nginx 站点文件和原有 `sites-enabled` 链接。先执行 `nginx -t`，成功后才 reload。
4. 执行 `systemctl daemon-reload`，启动 CMS 并完成健康检查、登录和关键业务冒烟测试。

示例骨架如下，实际时间戳和发布目录必须来自本次变更记录：

```bash
ROLLBACK_DIR=/root/tech-club-deploy-rollback-YYYYMMDDTHHMMSSZ
systemctl stop tech-club-cms.service
install -o root -g root -m 0644 /etc/systemd/system/tech-club-cms.service.before-YYYYMMDDTHHMMSSZ /etc/systemd/system/tech-club-cms.service
install -o root -g root -m 0600 /etc/tech-club-cms.env.before-YYYYMMDDTHHMMSSZ /etc/tech-club-cms.env
install -o root -g root -m 0644 /etc/nginx/sites-available/tech-club.conf.before-YYYYMMDDTHHMMSSZ /etc/nginx/sites-available/tech-club.conf
rm -f /etc/nginx/sites-enabled/tech-club.conf
test ! -e "$ROLLBACK_DIR/sites-enabled-tech-club.conf" || cp -a --no-dereference "$ROLLBACK_DIR/sites-enabled-tech-club.conf" /etc/nginx/sites-enabled/tech-club.conf
if test -e "$ROLLBACK_DIR/sites-enabled-default" || test -L "$ROLLBACK_DIR/sites-enabled-default"; then
    rm -f /etc/nginx/sites-enabled/default
    cp -a --no-dereference "$ROLLBACK_DIR/sites-enabled-default" /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl reload nginx
systemctl daemon-reload
systemctl restart tech-club-cms.service
systemctl is-active --quiet tech-club-cms.service
```

若旧默认站点曾被解除链接，按上例从 `/root/tech-club-deploy-rollback-YYYYMMDDTHHMMSSZ/` 恢复原链接。恢复符号链接时使用 `cp -a --no-dereference`，不要复制其目标内容，也不要同时启用两个声明相同 `default_server` 的站点；如 `nginx -t` 报冲突，应保持旧 Nginx 继续运行并重新核对链接，而不是强制 reload。

## 安装每日备份

备份包含固定路径 `/var/lib/tech-club` 和 `/etc/tech-club-cms.env`。脚本使用 `flock` 防并发，只在复制可变文件期间停止 CMS；复制完成后优先恢复原本 active 的服务，再压缩、校验并将同目录临时 `.tar.gz` 原子改名。

脚本依赖后端 SIGTERM 优雅退出成功。`systemctl stop` 失败、服务仍为 active 或 unit 的停止结果不是 `success` 时，脚本不会执行 tar，也不会发布归档。清理 trap 会先尝试启动原本 active 的 CMS 并用 `systemctl is-active` 验证，再尽力删除临时文件。

该机制不能覆盖 `SIGKILL`、OOM、内核/主机崩溃、断电或脚本进程被强制终止；这些情况无法保证 trap 执行。即使优雅停止成功，多个 JSON 的文件级一致快照也不等于跨文件业务事务，仍可能保留此前已产生的业务语义不一致，不能宣称绝对一致。

`ProtectSystem=strict` 要求目标备份目录在 unit 启动前已存在，必须先创建目录再安装和启动 service：

```bash
install -d -o root -g root -m 0700 /var/backups/tech-club
install -o root -g root -m 0750 deploy/scripts/backup-tech-club.sh /usr/local/sbin/backup-tech-club.sh
install -o root -g root -m 0644 deploy/systemd/tech-club-backup.service /etc/systemd/system/tech-club-backup.service
install -o root -g root -m 0644 deploy/systemd/tech-club-backup.timer /etc/systemd/system/tech-club-backup.timer
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/tech-club-backup.service /etc/systemd/system/tech-club-backup.timer
systemctl enable --now tech-club-backup.timer
```

unit 通过 `RuntimeDirectory=tech-club-backup` 创建 `root:root 0700` 的 `/run/tech-club-backup`，锁文件为 `/run/tech-club-backup/backup.lock`。直接以 root 手动运行脚本时，脚本会安全创建该运行目录。沙箱只允许写入 `/var/backups/tech-club` 和 `/run/tech-club-backup`。

首次安装后手动执行并检查归档清单和 SHA-256：

```bash
systemctl start tech-club-backup.service
systemctl status tech-club-backup.service --no-pager
BACKUP=/var/backups/tech-club/tech-club-YYYYMMDDTHHMMSSZ.tar.gz
ls -l "$BACKUP"
tar -tzf "$BACKUP"
sha256sum "$BACKUP"
```

归档目录为 `0700`，归档文件为 `0600`，默认保留 30 天。禁止将备份放入 `/var/www`、静态站点目录或其他 Web 可访问位置。

归档同时包含业务数据和可解密敏感字段的 `SESSION_SECRET`，单个归档泄露会同时失去数据与密钥的保密性。因此必须建立主机外加密备份、独立访问控制和异地副本；本机留存不能替代异地灾备。

## 恢复演练

至少每季度在隔离主机或隔离目录执行一次恢复演练，不要用生产服务作为首次测试：

```bash
BACKUP=/var/backups/tech-club/tech-club-YYYYMMDDTHHMMSSZ.tar.gz
RESTORE=/root/tech-club-restore-test
install -d -o root -g root -m 0700 "$RESTORE"
sha256sum "$BACKUP"
tar -xzf "$BACKUP" --no-same-owner -C "$RESTORE"
for file in "$RESTORE"/var/lib/tech-club/*.json; do jq -e '.version == 1 and (.iv | type == "string") and (.tag | type == "string") and (.data | type == "string")' "$file" >/dev/null; done
test -s "$RESTORE/etc/tech-club-cms.env"
```

演练应验证加密 envelope、上传文件、管理员登录、成员权限、项目工作区、使用申请与审批流水，并记录恢复耗时。正式恢复必须先停服务并保留当前目录，再恢复固定数据路径和环境文件，核对 JSON 为 `root:root 0600`、数据目录可供 Nginx 穿越但不可列出、上传目录可读，最后启动服务并完成健康检查。若失败，应停止服务并从恢复前目录回滚。

## 上线后检查

- `systemctl is-active tech-club-cms.service tech-club-backup.timer`
- `systemctl list-timers tech-club-backup.timer`
- `curl --fail --silent https://example.com/api/health`
- 未知 Host 不返回业务页面；点文件和 `/uploads/` 下含点路径不可访问，随机文件名加正常媒体扩展名仍可访问。
- 普通请求经 Nginx 限制为 `2 MiB`，JSON 再受 Express `1 MiB` 限制，只有精确上传接口使用 `101 MiB`/`100 MiB` 双层上限。
- CSS/JavaScript 不使用一年缓存，上传媒体和图片仍可长期缓存。
- 备份不在 Web 目录，并已复制到加密异地存储。
