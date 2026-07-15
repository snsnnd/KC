# 科创中心官网与运营系统

科创中心的公开官网、成员中心和运营后台。前端为无构建步骤的原生 HTML/CSS/JavaScript，后端为 Node.js + Express。

## 数据存储

当前没有使用关系型数据库，运行数据保存在 `DATA_DIR` 指定目录下的 JSON 文件中，邮件配置和资源密码使用 AES-256-GCM 加密 JSON 保存。生产环境使用 `/var/lib/tech-club`，文件权限为 `600`。

这种方案部署简单，适合当前中小规模社团；写入采用临时文件原子替换，库存和资金审批使用进程内串行锁。它不适合多实例部署或大量并发，达到该规模时应迁移到 PostgreSQL 或 SQLite，并使用数据库事务替代进程锁。

主要数据文件包括内容、申请、成员、管理员、通知、审计、库存、资金和审批记录。运行数据、上传文件、环境变量和账号密码不会进入 Git。

## 项目结构

```text
.
├── public/                 # 可公开部署的页面与静态资源
│   ├── assets/css/         # 官网、后台、子页面样式
│   ├── assets/js/          # 各页面控制器与静态回退数据
│   ├── assets/vendor/      # 浏览器端第三方依赖
│   └── *.html              # 保持现有公开 URL 的页面入口
├── backend/
│   ├── src/                # Express API 源码
│   ├── config/             # 初始内容配置
│   ├── tests/              # 隔离数据目录的端到端测试
│   ├── package.json
│   └── package-lock.json
├── deploy/
│   ├── nginx/              # Nginx 配置
│   ├── systemd/            # systemd 服务
│   └── scripts/            # 运维脚本
├── docs/                   # 架构、部署与本地私密账号文档
└── README.md
```

## 功能入口

- 统一入口：`/portal.html`
- 官网：`/`
- 后台工作区总览：`/admin.html`
- 运营宣发后台：`/admin.html?workspace=operations`
- 人员管理后台：`/admin.html?workspace=people`
- 资源与资金后台：`/admin.html?workspace=assets`
- 加入申请：`/join.html`
- 资源中心：`/resources.html`
- 成员中心：`/member.html`

项目支持独立分类、名称/编号/分类/标签/简介即时搜索，以及分类筛选。后台同样可以搜索和筛选项目，并更新每个项目的分类、标签、媒体、主题色和链接。

加入申请要求填写姓名、学号、班级、联系方式、申请部门和申请理由。申请转为成员后，学号和班级会保留在成员档案中。

物资和资金使用必须由成员提交申请，经主管理员或审核员批准后才会在串行锁中校验并扣减。所有访问、申请、审批、库存和资金操作均写入审计记录。

管理员和成员从统一入口选择身份登录。后台按管理员角色显示可进入的子后台；成员中心由服务端根据资源权限、`material.request` 和 `fund.request` 生成可见模块，未授权资源、库存和资金账户不会返回浏览器。

## 本地运行

安装并启动 API：

```bash
cd backend
npm ci
ADMIN_PASSWORD='replace-with-a-local-password' SESSION_SECRET='replace-with-a-random-secret' npm start
```

启动静态页面：

```bash
python3 -m http.server 8080 --directory public
```

运行检查与端到端测试：

```bash
cd backend
npm run check
npm run test:applications
npm run test:permissions
npm run test:resources
```

## Git 工作流

功能开发从主分支创建短分支，提交前运行后端检查和端到端测试。运行数据、上传内容、`.env`、SMTP 授权码及 `docs/TEST_ACCOUNTS.md` 均由 `.gitignore` 排除，禁止提交到仓库。

部署配置位于 `deploy/`。生产静态目录只接收 `public/` 的内容，后端只部署 `backend/`，避免源码、测试账号和运维文件暴露在 Web 根目录。
