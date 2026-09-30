#!/usr/bin/env bash
# ================================================================
# 科创社 CMS — 数据备份脚本
# 功能：停止 CMS 服务 -> 打包数据目录和加密环境文件 -> 重启服务
#       -> 压缩归档 -> 清理 30 天前的旧备份
# 部署路径: /usr/local/sbin/backup-tech-club.sh (root:root, 0700)
# 被 systemd timer: tech-club-backup.timer 定时触发
# ================================================================
set -Eeuo pipefail

PATH=/usr/sbin:/usr/bin:/sbin:/bin
# 安全注意：设置 umask 0077 确保创建的临时文件仅 root 可读写
umask 0077

readonly SERVICE_NAME="tech-club-cms.service"
readonly DATA_DIR="/var/lib/tech-club"
# 安全注意：环境文件含数据库密钥和 SMTP 凭据，必须严格保护
readonly ENV_FILE="/etc/tech-club-cms.env"
readonly BACKUP_DIR="/var/backups/tech-club"
# 备份保留天数：超过此天数的旧备份自动删除
readonly RETENTION_DAYS=30

# 临时文件变量（在 cleanup 中清理）
raw_tmp=""
compressed_tmp=""
# 服务原始状态标记（备份前是否在运行）
service_was_active=0

# 错误输出辅助函数
fail() {
    printf 'backup-tech-club: %s\n' "$*" >&2
    exit 1
}

# 如果备份前服务在运行，重新启动服务
restart_service() {
    if ((service_was_active)); then
        /usr/bin/systemctl start "$SERVICE_NAME"
        /usr/bin/systemctl is-active --quiet "$SERVICE_NAME"
        service_was_active=0
    fi
}

# 清理函数：确保无论成功或失败都重启服务并删除临时文件
cleanup() {
    local status=$?
    local cleanup_status
    local active_status
    trap - EXIT
    trap '' INT TERM
    set +e

    # 优先恢复服务可用性 —— 临时文件清理不得阻止重启
    if ((service_was_active)); then
        /usr/bin/systemctl start "$SERVICE_NAME"
        cleanup_status=$?
        /usr/bin/systemctl is-active --quiet "$SERVICE_NAME"
        active_status=$?
        if ((cleanup_status != 0 || active_status != 0)); then
            printf 'backup-tech-club: failed to restore active state for %s\n' "$SERVICE_NAME" >&2
            status=1
        else
            service_was_active=0
        fi
    fi

    # 删除原始 tar 临时文件
    if [[ -n "$raw_tmp" ]] && ! rm -f -- "$raw_tmp"; then
        printf 'backup-tech-club: failed to remove temporary file %s\n' "$raw_tmp" >&2
        status=1
    fi
    # 删除压缩后的临时文件
    if [[ -n "$compressed_tmp" ]] && ! rm -f -- "$compressed_tmp"; then
        printf 'backup-tech-club: failed to remove temporary file %s\n' "$compressed_tmp" >&2
        status=1
    fi

    exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ================ 前置安全检查 ================
# 必须以 root 身份运行（备份涉及 systemd 操作和读取敏感文件）
[[ $EUID -eq 0 ]] || fail "must run as root"
# 安全注意：数据目录不能是符号链接（防止链接到不可信路径）
[[ -d "$DATA_DIR" && ! -L "$DATA_DIR" ]] || fail "data directory must be a directory, not a symlink: $DATA_DIR"
# 安全注意：环境文件不能是符号链接（防止读取恶意文件）
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "environment file must be a regular, non-symlink file: $ENV_FILE"
# 安全注意：环境文件必须属于 root:root
[[ $(/usr/bin/stat -c '%u:%g' "$ENV_FILE") == "0:0" ]] || fail "environment file must be owned by root:root: $ENV_FILE"
# 安全注意：环境文件权限必须为 600（仅 root 可读写）
[[ $(/usr/bin/stat -c '%a' "$ENV_FILE") == "600" ]] || fail "environment file mode must be 0600: $ENV_FILE"
# 安全注意：备份目录不能是符号链接
[[ ! -L "$BACKUP_DIR" ]] || fail "backup directory must not be a symlink: $BACKUP_DIR"
# 确保 systemd 服务已加载
[[ $(/usr/bin/systemctl show --property=LoadState --value "$SERVICE_NAME") == "loaded" ]] || fail "systemd service is not loaded: $SERVICE_NAME"

# 安全注意：备份目录不能在 Web 根目录下（防止被 Nginx 直接访问）
case "$BACKUP_DIR" in
    /var/www|/var/www/*) fail "backup directory must not be under the web root" ;;
esac

# 创建备份目录（root 专用，0700 权限）
/usr/bin/install -d -o root -g root -m 0700 "$BACKUP_DIR"
# 创建运行时锁目录
/usr/bin/install -d -o root -g root -m 0700 "/run/tech-club-backup"
# 获取文件锁（防止多个备份进程同时运行）
exec 9>"/run/tech-club-backup/backup.lock"
/usr/bin/flock -n 9 || fail "another backup is already running"

# 生成时间戳（UTC ISO 8601 格式，如 20260728T120000Z）
timestamp=$(/usr/bin/date -u +%Y%m%dT%H%M%SZ)
archive="$BACKUP_DIR/tech-club-${timestamp}.tar.gz"
# 确保不覆盖已有备份
[[ ! -e "$archive" ]] || fail "backup already exists: $archive"

# 创建临时文件（与目标归档同目录 + 句柄后缀，保证原子性）
raw_tmp=$(/usr/bin/mktemp "$BACKUP_DIR/.tech-club-${timestamp}.XXXXXX.tar")
compressed_tmp=$(/usr/bin/mktemp "$BACKUP_DIR/.tech-club-${timestamp}.XXXXXX.tar.gz")
# 安全注意：临时文件必须严格权限
/usr/bin/chmod 0600 "$raw_tmp" "$compressed_tmp"

# 如果服务正在运行，先停止它以保证数据一致性
if /usr/bin/systemctl is-active --quiet "$SERVICE_NAME"; then
    service_was_active=1
    if ! /usr/bin/systemctl stop "$SERVICE_NAME"; then
        fail "failed to stop $SERVICE_NAME; no archive was created"
    fi
    if /usr/bin/systemctl is-active --quiet "$SERVICE_NAME"; then
        fail "$SERVICE_NAME is still active after stop; no archive was created"
    fi
    stop_result=$(/usr/bin/systemctl show --property=Result --value "$SERVICE_NAME")
    [[ "$stop_result" == "success" ]] || fail "$SERVICE_NAME did not stop cleanly (Result=$stop_result); no archive was created"
fi

# 仅在复制可变文件时停止服务；压缩和校验在重启后进行
/usr/bin/tar -C / -cf "$raw_tmp" "${DATA_DIR#/}" "${ENV_FILE#/}"
# 复制完成后立即重启服务，缩短停机时间
restart_service

# 压缩归档文件
/usr/bin/gzip -c "$raw_tmp" > "$compressed_tmp"
rm -f -- "$raw_tmp"
raw_tmp=""
# 校验归档完整性：列出文件列表，如果损坏则命令失败
/usr/bin/tar -tzf "$compressed_tmp" >/dev/null
/usr/bin/chmod 0600 "$compressed_tmp"
# 原子操作：移动压缩后的临时文件到正式归档路径
/usr/bin/mv -- "$compressed_tmp" "$archive"
compressed_tmp=""

# 清理过期备份（保留 RETENTION_DAYS 天内的备份）
/usr/bin/find "$BACKUP_DIR" -maxdepth 1 -type f -name 'tech-club-*.tar.gz' -mmin "+$((RETENTION_DAYS * 24 * 60))" -delete
printf 'backup-tech-club: created %s\n' "$archive"
