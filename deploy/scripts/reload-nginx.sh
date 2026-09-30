#!/bin/sh
# ================================================================
# 科创社 CMS — Nginx 配置重载脚本
# 功能：检查 Nginx 配置语法，若正确则热重载。
# 部署路径: /usr/local/sbin/reload-nginx.sh (root:root, 0700)
# 用于部署新站点配置后安全重载 Nginx。
# ================================================================
set -eu
# 先验证配置语法正确性，再执行重载
# 安全注意：如果配置有误，Nginx -t 会输出错误信息但返回非零退出码，
# 阻止 systemctl reload 执行，避免生产环境配置损坏导致服务不可用。
/usr/sbin/nginx -t >/dev/null 2>&1
/usr/bin/systemctl reload nginx
