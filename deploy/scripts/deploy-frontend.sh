#!/bin/sh
# ================================================================
# 科创社 CMS — 前端部署脚本
# 功能：将构建好的前端文件部署到 Web 根目录，支持回滚。
# 部署策略：创建新版本目录 => 原子替换 current 符号链接 =>
#           冒烟测试 => 异常时自动回滚。
# 用法: deploy-frontend.sh SOURCE_DIR [showcase|control] [RELEASE_ID]
#   SOURCE_DIR   — 构建好的前端文件目录
#   SURFACE      — showcase（展示/成员端）或 control（管理端）
#   RELEASE_ID   — 版本标识（可选，默认 UTC 时间戳）
# ================================================================
set -eu

SOURCE_DIR=${1:?usage: deploy-frontend.sh SOURCE_DIR [showcase|control] [RELEASE_ID]}
case "${2:-}" in
    showcase|control)
        SURFACE=$2
        RELEASE_ID=${3:-$(date -u +%Y%m%dT%H%M%SZ)}
        ;;
    *)
        # Existing deployments may still publish the combined root during migration.
        SURFACE=combined
        RELEASE_ID=${2:-$(date -u +%Y%m%dT%H%M%SZ)}
        ;;
esac
DOMAIN=${DOMAIN:?set DOMAIN to the certificate hostname before deploying}
case "$SURFACE" in
    showcase) DEFAULT_WEB_ROOT=/var/www/tech-club-showcase; SMOKE_PATH=/ ;;
    control) DEFAULT_WEB_ROOT=/var/www/tech-club-control; SMOKE_PATH=/admin.html ;;
    combined) DEFAULT_WEB_ROOT=/var/www/tech-club; SMOKE_PATH=/ ;;
esac
WEB_ROOT=${WEB_ROOT:-$DEFAULT_WEB_ROOT}
RELEASES_DIR="$WEB_ROOT/releases"
CURRENT_LINK="$WEB_ROOT/current"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
TEMP_DIR="$RELEASES_DIR/.${RELEASE_ID}.tmp"
NEXT_LINK="$WEB_ROOT/.current-${RELEASE_ID}"

# 验证 RELEASE_ID 仅含安全字符（字母、数字、点、下划线、短横线）
case "$RELEASE_ID" in (*[!A-Za-z0-9._-]*|'') echo "invalid release id" >&2; exit 1;; esac
test "$(id -u)" -eq 0 || { echo "must run as root" >&2; exit 1; }
test -d "$SOURCE_DIR" || { echo "source directory not found: $SOURCE_DIR" >&2; exit 1; }
test ! -e "$RELEASE_DIR" || { echo "release already exists: $RELEASE_DIR" >&2; exit 1; }

# 创建必要的目录结构（ACME 目录用于 Let's Encrypt 验证）
install -d -o root -g root -m 0755 "$WEB_ROOT" "$RELEASES_DIR" /var/www/tech-club-acme
rm -rf -- "$TEMP_DIR" "$NEXT_LINK"
trap 'rm -rf -- "$TEMP_DIR" "$NEXT_LINK"' EXIT INT TERM
install -d -o root -g root -m 0755 "$TEMP_DIR"
# 复制源文件到临时目录（保留权限和属性）
cp -a "$SOURCE_DIR"/. "$TEMP_DIR"/
# 上传源可能来自宽松权限的共享文件系统；发布目录统一为只读静态资产权限。
chown -R root:root "$TEMP_DIR"
find "$TEMP_DIR" -type d -exec chmod 0755 {} +
find "$TEMP_DIR" -type f -exec chmod 0644 {} +

# 验证当前发布面的必需文件。
case "$SURFACE" in
    showcase) REQUIRED_FILES="index.html portal.html join.html member.html resources.html resource.html bug-report.html activate.html email-approval.html assets/js/site-data.js assets/js/app.js assets/js/desktop-experience.js assets/vendor/three.module.min.js assets/css/home.css" ;;
    control) REQUIRED_FILES="admin.html assets/js/admin.js assets/css/admin.css" ;;
    combined) REQUIRED_FILES="index.html portal.html admin.html join.html member.html resources.html resource.html bug-report.html activate.html email-approval.html assets/js/site-data.js assets/js/app.js assets/js/desktop-experience.js assets/vendor/three.module.min.js assets/js/admin.js assets/css/home.css assets/css/admin.css" ;;
esac
for required in $REQUIRED_FILES; do
    test -f "$TEMP_DIR/$required" || { echo "missing frontend file: $required" >&2; exit 1; }
done

# 原子操作：将临时目录重命名为正式发布目录
mv -- "$TEMP_DIR" "$RELEASE_DIR"
previous_target=""
# 保存当前版本的目标路径，用于回滚
if test -L "$CURRENT_LINK"; then previous_target=$(readlink -f "$CURRENT_LINK"); fi
# 原子符号链接替换：先创建一个临时链接，再改名覆盖 current
ln -s "$RELEASE_DIR" "$NEXT_LINK"
mv -Tf -- "$NEXT_LINK" "$CURRENT_LINK"

# ---- 冒烟测试 ----
# 验证当前页面和后端可写健康状态均正常。
health=$(curl --fail --silent --show-error --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" || true)
case "$health" in
    *'"ok":true'*'"writeHealthy":true'*) health_ok=true ;;
    *) health_ok=false ;;
esac
if ! curl --fail --silent --show-error --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$SMOKE_PATH" >/dev/null \
    || test "$health_ok" != true; then
    # 冒烟测试失败：回滚到上一个版本
    if test -n "$previous_target"; then
        ln -s "$previous_target" "$NEXT_LINK"
        mv -Tf -- "$NEXT_LINK" "$CURRENT_LINK"
        rollback_message="previous release restored"
    else
        rm -f -- "$CURRENT_LINK"
        rollback_message="failed first release removed"
    fi
    echo "frontend smoke check failed; $rollback_message" >&2
    exit 1
fi

trap - EXIT INT TERM
echo "$SURFACE frontend release active: $RELEASE_DIR"
