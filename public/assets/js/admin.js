(function () {
  "use strict";

  const initialUrl = new URL(window.location.href);
  const requestedApplicantId = initialUrl.searchParams.get("notifyApplicant") || "";
  const usesLegacyNotificationUrl = initialUrl.searchParams.get("workspace") === "operations" && initialUrl.hash === "#notifications";
  if (usesLegacyNotificationUrl) initialUrl.searchParams.set("workspace", "notifications");
  if (requestedApplicantId) {
    initialUrl.searchParams.delete("notifyApplicant");
  }
  if (requestedApplicantId || usesLegacyNotificationUrl) {
    window.history.replaceState(null, "", `${initialUrl.pathname}${initialUrl.search}${initialUrl.hash}`);
  }
  const state = { csrf: "", user: null, workspace: "home", content: null, contentResourceDraftDirty: false, applications: [], mail: null, managers: [], members: [], workspaceMemberOptions: [], notificationAudience: { members: [], applicants: [], membersUpdatedAt: null, applicationsUpdatedAt: null }, requestedApplicantId, resourceSecrets: {}, notifications: [], memberMessages: [], uploads: [], inventory: { items: [], ledger: [] }, funds: { accounts: [], ledger: [] }, usageRequests: [], projectWorkspaces: [], projectWorkspacesError: "", projectWorkspaceFormDirty: false, workspaceAllocationOptions: { inventory: [], funds: [] }, bugReports: [], loadErrors: {}, audit: [], syncTimer: 0 };
  let inventoryImportReady = false;
  let inventoryImportGeneration = 0;
  let projectWorkspaceLoadGeneration = 0;
  const inventoryImageOperations = new Map();
  const workspaces = {
    operations: { name: "运营宣发", code: "OPERATIONS", panels: ["settings", "projects", "project-workspaces", "mail", "uploads"] },
    people: { name: "人员管理", code: "PEOPLE", panels: ["departments", "applications", "members", "managers", "audit"] },
    assets: { name: "资源与资金", code: "ASSETS", panels: ["resources", "inventory", "funds", "usage"] },
    notifications: { name: "通知中心", code: "NOTIFICATIONS", panels: ["notifications"] }
  };
  const assignablePanels = {
    settings: "基础信息",
    projects: "项目内容",
    "project-workspaces": "项目协作",
    departments: "招新部门",
    resources: "资源链接",
    applications: "申请审核",
    notifications: "通知中心",
    uploads: "媒体上传",
    members: "人员管理",
    audit: "操作日志",
    inventory: "物资库存",
    funds: "资金账户",
    usage: "使用审批"
  };
  const loginView = document.querySelector("#loginView");
  const adminView = document.querySelector("#adminView");
  const saveStatus = document.querySelector("#saveStatus");

  function canAccessPanel(panel, user = state.user) {
    return user?.role === "owner" || (user?.panelPermissions || []).includes(panel);
  }

  function safeUrl(value) {
    const url = String(value || "").trim();
    if (url.startsWith("/uploads/")) return url;
    try {
      const parsed = new URL(url);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function formatDate(value, fallback = "未设置", dateOnly = false) {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return dateOnly ? date.toLocaleDateString("zh-CN") : date.toLocaleString("zh-CN");
  }

  function leadNotificationStatus(notification, isUpdate) {
    const assigneeCount = Number(notification?.assigneeCount) || 0;
    const recipientCount = Number(notification?.recipientCount) || 0;
    if (!assigneeCount) return { text: "", warning: false };
    if (!recipientCount) return { text: ` / ${isUpdate ? "新增" : "项目"}负责人未配置邮箱，未发送邮件`, warning: true };
    if (notification.sent) return { text: ` / 已邮件通知 ${recipientCount} 名${isUpdate ? "新增" : ""}负责人`, warning: false };
    if (notification.rateLimited) return { text: " / 负责人通知邮件频率受限", warning: true };
    return { text: " / 负责人通知邮件发送失败", warning: true };
  }

  function openImageViewer(value, title) {
    const url = safeUrl(value);
    if (!url) return;
    const previousFocus = document.activeElement;
    const viewer = document.createElement("div");
    viewer.className = "image-viewer";
    viewer.setAttribute("role", "dialog");
    viewer.setAttribute("aria-modal", "true");
    viewer.setAttribute("aria-labelledby", "inventoryImageViewerTitle");
    const panel = document.createElement("div");
    panel.className = "image-viewer__panel";
    const heading = document.createElement("div");
    const label = document.createElement("b");
    label.id = "inventoryImageViewerTitle";
    label.textContent = title;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭 ×";
    const image = document.createElement("img");
    image.src = url;
    image.alt = title;
    const dismiss = () => { viewer.remove(); previousFocus?.focus?.(); };
    close.addEventListener("click", dismiss);
    viewer.addEventListener("click", (event) => { if (event.target === viewer) dismiss(); });
    viewer.addEventListener("keydown", (event) => { if (event.key === "Escape") dismiss(); if (event.key === "Tab") { event.preventDefault(); close.focus(); } });
    heading.append(label, close);
    panel.append(heading, image);
    viewer.appendChild(panel);
    document.body.appendChild(viewer);
    close.focus();
  }

  async function uploadInventoryImage(file) {
    const body = new FormData();
    body.append("file", file);
    return api("/api/admin/inventory-image", { method: "POST", body });
  }

  function queueInventoryImageMutation(itemId, field, operation) {
    const key = `${itemId}:${field}`;
    const previous = inventoryImageOperations.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    inventoryImageOperations.set(key, next);
    next.then(() => { if (inventoryImageOperations.get(key) === next) inventoryImageOperations.delete(key); }, () => { if (inventoryImageOperations.get(key) === next) inventoryImageOperations.delete(key); });
    return next;
  }

  async function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (state.csrf && options.method && options.method !== "GET") headers["x-csrf-token"] = state.csrf;
    if (options.body && !(options.body instanceof FormData)) headers["content-type"] = "application/json";
    const response = await fetch(url, { credentials: "same-origin", ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || "请求失败");
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function setStatus(message, isError = false) {
    saveStatus.textContent = message;
    saveStatus.style.color = isError ? "var(--orange)" : "var(--accent)";
  }

  async function optionalLoad(key, enabled, loader, fallback) {
    delete state.loadErrors[key];
    if (!enabled) return fallback;
    try {
      return await loader();
    } catch (error) {
      state.loadErrors[key] = error.message;
      return fallback;
    }
  }

  function showDashboardLoadErrors() {
    const labels = { applications: "申请审核", mail: "邮件设置", audit: "操作日志", managers: "管理员", members: "成员", notificationAudience: "通知对象", notifications: "通知记录", memberMessages: "成员问询", inventory: "物资库存", funds: "资金账户", usageRequests: "使用审批", bugReports: "Bug 反馈", projectWorkspaces: "项目协作" };
    const targets = {
      applications: "#applicationList",
      mail: "#mailMessage",
      audit: "#auditList",
      managers: "#managerList",
      members: "#memberList",
      notificationAudience: "#notificationSummary",
      notifications: "#notificationHistory",
      memberMessages: "#memberMessageAdminList",
      inventory: "#inventoryList",
      funds: "#fundList",
      usageRequests: "#usageRequestList",
      bugReports: "#bugReportList"
    };
    Object.entries(state.loadErrors).forEach(([key, error]) => {
      const target = targets[key] ? document.querySelector(targets[key]) : null;
      if (target) target.textContent = `${labels[key] || key}加载失败：${error}`;
    });
    const failed = Object.keys(state.loadErrors).map((key) => labels[key] || key);
    if (failed.length) setStatus(`部分数据加载失败：${failed.join(" / ")}`, true);
  }

  async function refreshPanel(button, load, render, successMessage) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "刷新中...";
    try {
      await load();
      render();
      setStatus(successMessage);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  function field(labelText, value, key, options = {}) {
    const label = document.createElement("label");
    label.className = `field${options.wide ? " field--wide" : ""}`;
    label.append(document.createTextNode(labelText));
    const input = options.multiline ? document.createElement("textarea") : document.createElement("input");
    input.value = value || "";
    input.dataset.field = key;
    if (options.type) input.type = options.type;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.pattern) input.pattern = options.pattern;
    if (options.required) input.required = true;
    label.appendChild(input);
    if (options.help) {
      const help = document.createElement("small");
      help.textContent = options.help;
      label.appendChild(help);
    }
    return label;
  }

  function card(title, index, removeHandler) {
    const article = document.createElement("article");
    article.className = "editor-card";
    article.dataset.index = index;
    const head = document.createElement("div");
    head.className = "editor-card__head";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "删除";
    remove.addEventListener("click", removeHandler);
    head.append(heading, remove);
    article.appendChild(head);
    return article;
  }

  function renderSettings() {
    const editor = document.querySelector("#settingsEditor");
    editor.replaceChildren(
      field("社团中文名", state.content.settings.clubName, "clubName"),
      field("社团英文名", state.content.settings.englishName, "englishName"),
      field("首屏标题", state.content.settings.heroTitle, "heroTitle", { wide: true }),
      field("首屏介绍", state.content.settings.heroDescription, "heroDescription", { wide: true, multiline: true }),
      field("公开联系邮箱", state.content.settings.contactEmail, "contactEmail", { type: "email" }),
      field("申请通知邮箱", state.content.settings.managerEmail, "managerEmail", { type: "email" })
    );
  }

  function renderProjects() {
    const editor = document.querySelector("#projectEditor");
    editor.replaceChildren();
    state.content.projects.forEach((project, index) => {
      const article = card(`${String(index + 1).padStart(2, "0")} / ${project.title || "未命名项目"}`, index, () => {
        state.content = collectContent();
        state.content.projects.splice(index, 1);
        renderProjects();
      });
      article.dataset.projectCategory = project.category || "未分类";
      article.dataset.projectSearch = [project.id, project.title, project.category, project.description, ...(project.tags || [])].join(" ").toLocaleLowerCase("zh-CN");
      const grid = document.createElement("div");
      grid.className = "editor-grid";
      grid.append(
        field("系统编号", project.id, "id", { maxLength: 40, required: true, help: "唯一且上线后保持稳定，建议 SYS_001 格式。" }),
        field("项目名称", project.title, "title", { maxLength: 100, required: true, help: "使用作品真实名称，不写宣传口号。" }),
        field("项目分类", project.category || "未分类", "category", { maxLength: 40, help: "使用稳定分类，例如机器人、人工智能、物联网。" }),
        field("主题色", project.color, "color", { type: "color" }), field("标签（英文逗号分隔）", project.tags.join(", "), "tags"),
        field("项目简介", project.description, "description", { wide: true, multiline: true, maxLength: 800, help: "说明解决的问题、核心方案和真实结果，建议 40–160 字。" }),
        field("视频地址", project.video, "video", { placeholder: "/uploads/SYS_001-demo-v1.mp4", help: "建议 1080p、30–90 秒、MP4 或 WebM。" }),
        field("海报地址", project.poster, "poster", { placeholder: "/uploads/SYS_001-poster-v1.webp", help: "建议 1600×1000、WebP 或 AVIF，并与视频首帧一致。" })
      );
      const links = document.createElement("div");
      links.className = "link-editor";
      links.dataset.links = "true";
      (project.links || []).forEach((link) => addLinkRow(links, link));
      const addLink = document.createElement("button");
      addLink.type = "button";
      addLink.className = "small-button";
      addLink.textContent = "+ 添加项目链接";
      addLink.addEventListener("click", () => addLinkRow(links, { label: "VIEW RESOURCE", url: "" }));
      links.appendChild(addLink);
      grid.appendChild(links);
      article.appendChild(grid);
      editor.appendChild(article);
    });
    updateProjectFilters();
  }

  function renderAchievements() {
    const editor = document.querySelector("#achievementEditor");
    editor.replaceChildren();
    (state.content.achievements || []).forEach((achievement, index) => {
      const article = card(`${String(index + 1).padStart(2, "0")} / ${achievement.title || "未命名成果"}`, index, () => {
        state.content = collectContent();
        state.content.achievements.splice(index, 1);
        renderAchievements();
      });
      const grid = document.createElement("div");
      grid.className = "editor-grid";
      grid.append(
        field("成果编号", achievement.id, "id"), field("成果名称", achievement.title, "title"),
        field("成果类型", achievement.type || "项目成果", "type"), field("日期 / 年份", achievement.date || "", "date"),
        field("关联项目编号", achievement.projectId || "", "projectId", { placeholder: "SYS_001" }),
        field("展示图片", achievement.image || "", "image", { placeholder: "/uploads/achievement.webp" }),
        field("详情链接", achievement.url || "", "url", { placeholder: "https://..." }),
        field("成果说明", achievement.description || "", "description", { wide: true, multiline: true })
      );
      article.appendChild(grid);
      editor.appendChild(article);
    });
    if (!(state.content.achievements || []).length) editor.textContent = "NO ACHIEVEMENTS / 暂无独立成果，官网将使用项目生成默认展示";
  }

  function updateProjectFilters() {
    const categorySelect = document.querySelector("#adminProjectCategory");
    const selectedCategory = categorySelect.value;
    const categories = [...new Set(state.content.projects.map((project) => project.category || "未分类"))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    categorySelect.replaceChildren(new Option("全部分类", ""), ...categories.map((category) => new Option(category, category)));
    categorySelect.value = categories.includes(selectedCategory) ? selectedCategory : "";
    filterProjectEditor();
  }

  function filterProjectEditor() {
    const query = document.querySelector("#adminProjectSearch").value.trim().toLocaleLowerCase("zh-CN");
    const category = document.querySelector("#adminProjectCategory").value;
    const cards = [...document.querySelectorAll("#projectEditor .editor-card")];
    let visible = 0;
    cards.forEach((article) => {
      const matches = (!category || article.dataset.projectCategory === category) && (!query || article.dataset.projectSearch.includes(query));
      article.hidden = !matches;
      if (matches) visible += 1;
    });
    document.querySelector("#adminProjectCount").textContent = `${visible} / ${cards.length} PROJECTS`;
  }

  function addLinkRow(container, link) {
    const row = document.createElement("div");
    row.className = "link-row";
    const label = document.createElement("input");
    label.value = link.label || "";
    label.dataset.linkField = "label";
    label.placeholder = "按钮文字";
    const url = document.createElement("input");
    url.value = link.url || "";
    url.dataset.linkField = "url";
    url.placeholder = "https://...";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => row.remove());
    row.append(label, url, remove);
    const addButton = container.querySelector(".small-button");
    container.insertBefore(row, addButton || null);
  }

  function renderDepartments() {
    const editor = document.querySelector("#departmentEditor");
    editor.replaceChildren();
    state.content.departments.forEach((department, index) => {
      const article = card(`${String(index + 1).padStart(2, "0")} / ${department.name || "未命名部门"}`, index, () => {
        state.content = collectContent();
        state.content.departments.splice(index, 1);
        renderDepartments();
      });
      const grid = document.createElement("div");
      grid.className = "editor-grid";
      grid.append(field("部门 ID", department.id, "id"), field("部门名称", department.name, "name"), field("账号简写", department.accountPrefix || "", "accountPrefix", { placeholder: "例如 S" }), field("部门介绍", department.description, "description", { wide: true, multiline: true }));
      const openLabel = document.createElement("label");
      openLabel.className = "check-field";
      const open = document.createElement("input");
      open.type = "checkbox";
      open.checked = department.isOpen;
      open.dataset.field = "isOpen";
      openLabel.append(open, document.createTextNode("当前开放申请"));
      grid.appendChild(openLabel);
      article.appendChild(grid);
      editor.appendChild(article);
    });
  }

  function renderResources() {
    const editor = document.querySelector("#resourceEditor");
    editor.replaceChildren();
    state.content.resources.forEach((resource, index) => editor.appendChild(createResourceNodeEditor(resource, index, 0)));
  }

  function createResourceNodeEditor(resource, index, depth) {
    let article;
    article = card(`${depth ? "子资源" : String(index + 1).padStart(2, "0")} / ${resource.title || "未命名资源"}`, index, () => article.remove());
    article.classList.add("resource-node-editor");
    article.dataset.resourceNode = "true";
    article.dataset.depth = String(depth);
    const grid = document.createElement("div");
    grid.className = "editor-grid";
    grid.append(
      field("资源 ID（全站唯一）", resource.id, "id"), field("资源名称", resource.title, "title"),
      field("资源类型", resource.type, "type", { placeholder: (resource.children || []).length ? "COLLECTION" : "WEBSITE" }), field("主链接", resource.url, "url"),
      field("资源介绍", resource.description, "description", { wide: true, multiline: true }),
      field("公开访问说明", resource.accessNote, "accessNote", { wide: true }),
      field("权限标识（子资源会继承合集权限）", resource.permissionKey || "", "permissionKey", { placeholder: "resource.basic" }),
      field("受保护密码 / 提取码", Object.hasOwn(resource, "accessSecret") ? resource.accessSecret : state.resourceSecrets[resource.id] || "", "accessSecret", { placeholder: "该节点的所有链接共用" })
    );
    const links = document.createElement("div");
    links.className = "link-editor resource-link-editor";
    links.dataset.resourceLinks = "true";
    (resource.links || []).forEach((link) => addLinkRow(links, link));
    const addLink = document.createElement("button");
    addLink.type = "button";
    addLink.className = "small-button";
    addLink.textContent = "+ 添加链接";
    addLink.addEventListener("click", () => addLinkRow(links, { label: "打开资源", url: "" }));
    links.appendChild(addLink);
    grid.appendChild(links);
    article.appendChild(grid);
    if (depth < 2) {
      const children = document.createElement("div");
      children.className = "resource-children-editor";
      children.dataset.resourceChildren = "true";
      (resource.children || []).forEach((child, childIndex) => children.appendChild(createResourceNodeEditor(child, childIndex, depth + 1)));
      const addChild = document.createElement("button");
      addChild.type = "button";
      addChild.className = "small-button resource-add-child";
      addChild.textContent = "+ 添加子资源";
      addChild.addEventListener("click", () => {
        const childIndex = children.querySelectorAll(":scope > [data-resource-node]").length;
        children.insertBefore(createResourceNodeEditor({ id: "", title: "新子资源", description: "", type: "WEBSITE", url: "", links: [], accessNote: "", permissionKey: "", children: [] }, childIndex, depth + 1), addChild);
      });
      children.appendChild(addChild);
      article.appendChild(children);
    }
    return article;
  }

  function collectFields(root) {
    return Object.fromEntries([...root.querySelectorAll("[data-field]")].map((input) => [input.dataset.field, input.type === "checkbox" ? input.checked : input.value]));
  }

  function collectContent() {
    const settings = collectFields(document.querySelector("#settingsEditor"));
    const projects = [...document.querySelectorAll("#projectEditor .editor-card")].map((article) => {
      const values = collectFields(article);
      const links = [...article.querySelectorAll(".link-row")].map((row) => ({
        label: row.querySelector('[data-link-field="label"]').value,
        url: safeUrl(row.querySelector('[data-link-field="url"]').value)
      }));
      return { ...values, video: safeUrl(values.video), poster: safeUrl(values.poster), tags: values.tags.split(",").map((tag) => tag.trim()).filter(Boolean), links };
    });
    const achievements = [...document.querySelectorAll("#achievementEditor .editor-card")].map((article) => {
      const values = collectFields(article);
      return { ...values, image: safeUrl(values.image), url: safeUrl(values.url) };
    });
    const departments = [...document.querySelectorAll("#departmentEditor .editor-card")].map(collectFields);
    const collectResourceNode = (article) => {
      const resource = collectFields(article.querySelector(":scope > .editor-grid"));
      resource.url = safeUrl(resource.url);
      const linkEditor = article.querySelector(":scope > .editor-grid > [data-resource-links]");
      resource.links = [...linkEditor.querySelectorAll(":scope > .link-row")].map((row) => ({ label: row.querySelector('[data-link-field="label"]').value, url: safeUrl(row.querySelector('[data-link-field="url"]').value) }));
      const children = article.querySelector(":scope > [data-resource-children]");
      resource.children = children ? [...children.children].filter((child) => child.matches("[data-resource-node]")).map(collectResourceNode) : [];
      if (!resource.accessSecret && state.resourceSecrets[resource.id]) resource.clearSecret = true;
      return resource;
    };
    const resources = [...document.querySelectorAll("#resourceEditor > [data-resource-node]")].map(collectResourceNode);
    return { settings, projects, achievements, departments, resources, _meta: state.content._meta || { revision: 0 } };
  }

  async function saveContent() {
    try {
      setStatus("SAVING...");
      const payload = await api("/api/admin/content", { method: "PUT", body: JSON.stringify(collectContent()) });
      state.content = payload.content;
      state.contentResourceDraftDirty = false;
      state.resourceSecrets = canAccessPanel("resources") && ["owner", "editor"].includes(state.user.role) ? await api("/api/admin/resource-secrets", { method: "POST", body: "{}" }) : {};
      renderAllEditors();
      setStatus("SAVED / SYNCED");
    } catch (error) {
      setStatus(error.message, true);
      if (error.status === 409) {
        const syncButton = document.querySelector("#syncButton");
        syncButton.hidden = false;
        syncButton.classList.add("sync-alert");
      }
    }
  }

  function renderApplications() {
    const list = document.querySelector("#applicationList");
    const newCount = state.applications.filter((application) => application.status === "new").length;
    document.querySelector("#applicationBadge").textContent = newCount;
    list.replaceChildren();
    if (!state.applications.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "NO APPLICATIONS / 暂无申请";
      list.appendChild(empty);
      return;
    }
    state.applications.forEach((application) => {
      const article = document.createElement("article");
      article.className = "application-card";
      const identity = document.createElement("div");
      const name = document.createElement("h2");
      name.textContent = application.name;
      const meta = document.createElement("code");
      meta.textContent = `${application.id}\n${new Date(application.createdAt).toLocaleString("zh-CN")}`;
      identity.append(name, meta);
      const contact = document.createElement("p");
      contact.textContent = `部门：${application.departmentName}\n学号：${application.studentId || "历史记录未填写"}\n班级：${application.className || "历史记录未填写"}\n联系方式：${application.contact}\n邮箱：${application.email || "未填写"}`;
      const motivation = document.createElement("p");
      motivation.textContent = `${application.motivation}${application.portfolio ? `\n\n作品：${application.portfolio}` : ""}`;
      const controls = document.createElement("div");
      const status = document.createElement("select");
      [["new", "新申请"], ["reviewing", "审核中"], ["accepted", "已通过"], ["rejected", "未通过"]].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = application.status === value;
        status.appendChild(option);
      });
      status.addEventListener("change", async () => {
        status.disabled = true;
        try {
          const payload = await api(`/api/admin/applications/${encodeURIComponent(application.id)}`, { method: "PATCH", body: JSON.stringify({ status: status.value }) });
          Object.assign(application, payload.application);
          renderApplications();
          if (["accepted", "rejected"].includes(status.value)) setStatus(payload.notified ? "APPLICATION DECIDED / RESULT EMAIL SENT" : "APPLICATION DECIDED / RESULT EMAIL NOT SENT", !payload.notified);
        } catch (error) {
          setStatus(error.message, true);
          status.value = application.status;
        } finally {
          status.disabled = ["accepted", "rejected"].includes(application.status);
        }
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "删除申请";
      remove.addEventListener("click", async () => {
        if (!window.confirm(`确认删除 ${application.name} 的申请？`)) return;
        remove.disabled = true;
        try {
          await api(`/api/admin/applications/${encodeURIComponent(application.id)}`, { method: "DELETE" });
          state.applications = state.applications.filter((item) => item.id !== application.id);
          renderApplications();
        } catch (error) {
          setStatus(error.message, true);
        } finally {
          remove.disabled = false;
        }
      });
      controls.appendChild(status);
      if (["accepted", "rejected"].includes(application.status)) status.disabled = true;
      if (!application.memberId) {
        const reviewNote = document.createElement("textarea");
        reviewNote.placeholder = "审批意见（可选，将写入结果邮件）";
        const approve = document.createElement("button");
        approve.type = "button";
        approve.className = "small-button";
        approve.textContent = "通过申请";
        const reject = document.createElement("button");
        reject.type = "button";
        reject.className = "danger-button";
        reject.textContent = "拒绝申请";
        const decide = async (decision) => {
          approve.disabled = true;
          reject.disabled = true;
          try {
            const payload = await api(`/api/admin/applications/${encodeURIComponent(application.id)}`, { method: "PATCH", body: JSON.stringify({ status: decision, reviewNote: reviewNote.value }) });
            Object.assign(application, payload.application);
            renderApplications();
            setStatus(payload.notified ? "APPLICATION DECIDED / RESULT EMAIL SENT" : "APPLICATION DECIDED / RESULT EMAIL NOT SENT", !payload.notified);
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            approve.disabled = false;
            reject.disabled = false;
          }
        };
        const decisionButtons = [];
        if (application.status !== "accepted") { approve.addEventListener("click", () => decide("accepted")); decisionButtons.push(approve); }
        if (application.status !== "rejected") { reject.addEventListener("click", () => decide("rejected")); decisionButtons.push(reject); }
        controls.append(reviewNote, ...decisionButtons);
        if (!["accepted", "rejected"].includes(application.status)) {
          const resend = document.createElement("button");
          resend.type = "button";
          resend.className = "small-button";
          resend.textContent = "重发审批邮件";
          resend.addEventListener("click", async () => {
            resend.disabled = true;
            try {
              const payload = await api(`/api/admin/applications/${encodeURIComponent(application.id)}/send-approval-email`, { method: "POST", body: "{}" });
              setStatus(payload.notified ? "APPROVAL EMAIL SENT" : "APPROVAL EMAIL NOT SENT", !payload.notified);
            } catch (error) { setStatus(error.message, true); }
            finally { resend.disabled = false; }
          });
          controls.appendChild(resend);
        }
        if (application.email) {
          const notify = document.createElement("button");
          notify.type = "button";
          notify.className = "small-button";
          notify.textContent = "通知此申请人";
          notify.addEventListener("click", () => window.location.assign(`/admin.html?workspace=notifications&notifyApplicant=${encodeURIComponent(application.id)}#notifications`));
          controls.appendChild(notify);
        }
      } else {
        status.disabled = true;
      }
      if (["owner", "editor"].includes(state.user?.role)) {
        if (!application.memberId && application.status === "accepted" && canAccessPanel("members")) {
          const promote = document.createElement("button");
          promote.type = "button";
          promote.className = "small-button";
          promote.textContent = "转为成员";
          promote.addEventListener("click", async () => {
            const permissionText = window.prompt("初始资源权限（逗号分隔，可留空）", "resource.basic") || "";
            promote.disabled = true;
            try {
              const payload = await api(`/api/admin/applications/${encodeURIComponent(application.id)}/promote`, { method: "POST", body: JSON.stringify({ permissions: permissionText.split(",").map((item) => item.trim()).filter(Boolean) }) });
              Object.assign(application, payload.application);
              state.members.push(payload.member);
              renderApplications();
              if (canAccessPanel("members")) renderMembers();
              if (state.user.role === "owner") renderManagerFormAccess();
              setStatus(`MEMBER CREATED / ${payload.member.username} / 激活码 ${payload.activationCode}${payload.activationNotified ? " / 已发送邮箱" : " / 请转交成员"}`);
            } catch (error) { setStatus(error.message, true); }
            finally { promote.disabled = false; }
          });
          controls.appendChild(promote);
        }
        if (state.user.role === "owner") controls.appendChild(remove);
      }
      article.append(identity, contact, motivation, controls);
      list.appendChild(article);
    });
  }

  function renderAllEditors() {
    if (canAccessPanel("settings")) renderSettings();
    if (canAccessPanel("projects")) { renderProjects(); renderAchievements(); }
    if (canAccessPanel("departments")) renderDepartments();
    if (canAccessPanel("resources")) renderResources();
  }

  function recordId(value) {
    return typeof value === "string" ? value : value?.id || value?.memberId || "";
  }

  function workspaceIds(workspace, kind) {
    const candidates = kind === "leaders"
      ? [workspace.managerIds, workspace.leaderIds, workspace.leaders, workspace.leaderMembers, workspace.owners]
      : [workspace.memberIds, workspace.members, workspace.memberDetails];
    return (candidates.find(Array.isArray) || []).map(recordId).filter(Boolean);
  }

  function projectWorkspaceList(payload) {
    if (Array.isArray(payload)) return payload;
    for (const key of ["projectWorkspaces", "workspaces", "items"]) if (Array.isArray(payload?.[key])) return payload[key];
    return [];
  }

  function applyProjectWorkspacePayload(payload) {
    state.projectWorkspaces = projectWorkspaceList(payload);
    if (Array.isArray(payload?.members)) state.workspaceMemberOptions = payload.members.map((member) => ({ ...member, status: member.status || "active" }));
    if (state.workspaceMemberOptions.length && !state.members.length) state.members = [...state.workspaceMemberOptions];
    if (!state.members.length) {
      const members = new Map();
      state.projectWorkspaces.flatMap((workspace) => workspace.members || []).forEach((member) => members.set(member.id, { ...member, status: member.status || "active" }));
      state.members = [...members.values()];
    }
    const inventoryOptions = Array.isArray(payload?.inventory?.items) ? payload.inventory.items : Array.isArray(payload?.inventory) ? payload.inventory : [];
    const fundOptions = Array.isArray(payload?.funds?.accounts) ? payload.funds.accounts : Array.isArray(payload?.funds) ? payload.funds : [];
    state.workspaceAllocationOptions = {
      inventory: inventoryOptions.filter((item) => !item.status || item.status === "active"),
      funds: fundOptions.filter((account) => !account.status || account.status === "active")
    };
  }

  function syncWorkspaceMemberOption(member) {
    if (!member?.id) return;
    const index = state.workspaceMemberOptions.findIndex((item) => item.id === member.id);
    if (member.status === "active") {
      if (index >= 0) state.workspaceMemberOptions[index] = { ...state.workspaceMemberOptions[index], ...member };
      else state.workspaceMemberOptions.push({ ...member });
    } else if (index >= 0) {
      state.workspaceMemberOptions.splice(index, 1);
    }
  }

  async function loadProjectWorkspaces() {
    const generation = ++projectWorkspaceLoadGeneration;
    let payload;
    try {
      payload = await api("/api/admin/project-workspaces?options=1");
    } catch (error) {
      if (generation !== projectWorkspaceLoadGeneration) return false;
      throw error;
    }
    if (generation !== projectWorkspaceLoadGeneration) return false;
    applyProjectWorkspacePayload(payload);
    state.projectWorkspacesError = "";
    delete state.loadErrors.projectWorkspaces;
    return true;
  }

  function projectAllocationTargets(type) {
    return type === "material" ? state.workspaceAllocationOptions.inventory : state.workspaceAllocationOptions.funds;
  }

  function fillAllocationTarget(select, type, selectedId, fallbackName = "") {
    select.replaceChildren();
    const targets = projectAllocationTargets(type);
    targets.forEach((target) => select.appendChild(new Option(`${target.name} / ${type === "material" ? target.unit : target.currency}`, target.id)));
    if (selectedId && !targets.some((target) => target.id === selectedId)) select.appendChild(new Option(`${fallbackName || selectedId} / 当前列表不可用`, selectedId));
    select.value = selectedId || select.options[0]?.value || "";
  }

  function addProjectAllocationRow(allocation = {}) {
    const container = document.querySelector("#projectAllocationRows");
    const row = document.createElement("div");
    row.className = "project-allocation-row";
    row.dataset.allocationId = allocation.id || "";
    const type = document.createElement("select");
    type.dataset.allocationField = "type";
    type.setAttribute("aria-label", "配额类型");
    type.appendChild(new Option("材料", "material"));
    if (state.user.role === "owner" || allocation.type === "fund") type.appendChild(new Option("资金", "fund"));
    type.value = allocation.type === "fund" ? "fund" : "material";
    const lockedFund = state.user.role !== "owner" && type.value === "fund";
    const target = document.createElement("select");
    target.dataset.allocationField = "targetId";
    target.setAttribute("aria-label", "配额目标");
    fillAllocationTarget(target, type.value, allocation.targetId || allocation.target?.id || "", allocation.targetName || allocation.name || allocation.target?.name || "");
    type.addEventListener("change", () => fillAllocationTarget(target, type.value, ""));
    const allocated = document.createElement("input");
    allocated.dataset.allocationField = "allocated";
    allocated.type = "number";
    allocated.min = "0.01";
    allocated.step = "0.01";
    allocated.required = true;
    allocated.value = allocation.allocated ?? 0;
    allocated.placeholder = "分配额度";
    const note = document.createElement("input");
    note.dataset.allocationField = "note";
    note.maxLength = 500;
    note.value = allocation.note || "";
    note.placeholder = "配额备注";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => {
      row.remove();
      state.projectWorkspaceFormDirty = true;
    });
    if (lockedFund) {
      row.classList.add("is-readonly");
      type.disabled = true;
      target.disabled = true;
      allocated.disabled = true;
      note.disabled = true;
      remove.disabled = true;
      remove.textContent = "资金配额只读";
    }
    row.append(type, target, allocated, note, remove);
    container.appendChild(row);
  }

  function syncProjectLeaderChoices() {
    const memberSelect = document.querySelector("#projectWorkspaceMembers");
    const leaderSelect = document.querySelector("#projectWorkspaceLeaders");
    const selectedMembers = new Set([...memberSelect.selectedOptions].map((option) => option.value));
    [...leaderSelect.options].forEach((option) => {
      option.disabled = !selectedMembers.has(option.value);
      if (option.disabled) option.selected = false;
    });
  }

  function populateProjectWorkspaceForm(workspace = null) {
    const form = document.querySelector("#projectWorkspaceForm");
    const projectSelect = document.querySelector("#projectWorkspaceProject");
    const memberSelect = document.querySelector("#projectWorkspaceMembers");
    const leaderSelect = document.querySelector("#projectWorkspaceLeaders");
    const projectId = workspace?.projectId || workspace?.project?.id || "";
    projectSelect.replaceChildren(new Option("不关联公开项目", ""));
    (state.content?.projects || []).forEach((project) => projectSelect.appendChild(new Option(`${project.id} / ${project.title}`, project.id)));
    if (projectId && !(state.content?.projects || []).some((project) => project.id === projectId)) projectSelect.appendChild(new Option(projectId, projectId));
    projectSelect.value = projectId;
    memberSelect.replaceChildren();
    leaderSelect.replaceChildren();
    const memberOptions = state.workspaceMemberOptions.length ? state.workspaceMemberOptions : state.members;
    memberOptions.filter((item) => item.status === "active").forEach((item) => {
      const label = `${item.name} / @${item.username || item.studentId || item.id}`;
      memberSelect.appendChild(new Option(label, item.id));
      leaderSelect.appendChild(new Option(label, item.id));
    });
    const memberIds = new Set(workspace ? workspaceIds(workspace, "members") : []);
    const leaderIds = new Set(workspace ? workspaceIds(workspace, "leaders") : []);
    [...memberSelect.options].forEach((option) => { option.selected = memberIds.has(option.value); });
    [...leaderSelect.options].forEach((option) => { option.selected = leaderIds.has(option.value); });
    syncProjectLeaderChoices();
    form.elements.id.value = workspace?.id || "";
    form.elements.revision.value = String(Number(workspace?.revision) || 0);
    form.elements.name.value = workspace?.name || "";
    form.elements.description.value = workspace?.description || "";
    const status = workspace?.status || "planning";
    if (![...form.elements.status.options].some((option) => option.value === status)) form.elements.status.appendChild(new Option(status, status));
    form.elements.status.value = status;
    document.querySelector("#projectWorkspaceAutoProgress").textContent = `${Math.max(0, Math.min(100, Number(workspace?.progress) || 0))}%（按已完成任务计算）`;
    document.querySelector("#projectAllocationRows").replaceChildren();
    (workspace?.allocations || []).forEach(addProjectAllocationRow);
    const submit = form.querySelector('button[type="submit"]');
    submit.textContent = workspace ? "SAVE WORKSPACE" : "CREATE WORKSPACE";
    document.querySelector("#cancelProjectWorkspaceEdit").hidden = !workspace;
    document.querySelector("#projectWorkspaceMessage").textContent = workspace ? `EDITING REVISION ${Number(workspace.revision) || 0}` : "";
    state.projectWorkspaceFormDirty = false;
  }

  function resetProjectWorkspaceForm() {
    const form = document.querySelector("#projectWorkspaceForm");
    form.reset();
    populateProjectWorkspaceForm();
    state.projectWorkspaceFormDirty = false;
    document.querySelector("#projectWorkspaceMessage").textContent = "";
  }

  function memberNameById(id) {
    const member = [...state.workspaceMemberOptions, ...state.members].find((item) => item.id === id);
    return member?.name || member?.username || id;
  }

  function renderProjectWorkspaces() {
    const list = document.querySelector("#projectWorkspaceList");
    const message = document.querySelector("#projectWorkspaceMessage");
    list.replaceChildren();
    if (state.projectWorkspacesError) {
      message.textContent = `项目工作区加载失败：${state.projectWorkspacesError}`;
      list.textContent = message.textContent;
      return;
    }
    state.projectWorkspaces.forEach((workspace) => {
      const article = document.createElement("article");
      article.className = "project-workspace-admin-card";
      const head = document.createElement("header");
      const identity = document.createElement("div");
      const code = document.createElement("span");
      code.textContent = `[ ${String(workspace.status || "unknown").toUpperCase()} / ${workspace.projectId || workspace.project?.id || "NO PUBLIC PROJECT"} ]`;
      const title = document.createElement("h2");
      title.textContent = workspace.name || "未命名工作区";
      const description = document.createElement("p");
      description.textContent = workspace.description || "暂无说明";
      identity.append(code, title, description);
      const metrics = document.createElement("div");
      metrics.className = "project-workspace-metrics";
      const taskCount = Array.isArray(workspace.tasks) ? workspace.tasks.length : Number(workspace.taskCount) || 0;
      const updateCount = Array.isArray(workspace.updates) ? workspace.updates.length : Number(workspace.updateCount) || 0;
      metrics.textContent = `REVISION ${Number(workspace.revision) || 0}\nPROGRESS ${Number(workspace.progress) || 0}%\nTASKS ${taskCount}\nUPDATES ${updateCount}`;
      head.append(identity, metrics);
      const people = document.createElement("p");
      people.className = "project-workspace-people";
      people.textContent = `负责人：${workspaceIds(workspace, "leaders").map(memberNameById).join(" / ") || "未指定"}\n成员：${workspaceIds(workspace, "members").map(memberNameById).join(" / ") || "未指定"}`;
      const taskDetails = document.createElement("section");
      taskDetails.className = "project-workspace-detail-section";
      const taskHeading = document.createElement("h3");
      const tasks = Array.isArray(workspace.tasks) ? workspace.tasks : [];
      const doneTasks = tasks.filter((task) => task.status === "done").length;
      taskHeading.textContent = `任务明细 / 已完成 ${doneTasks} / ${tasks.length}`;
      const taskList = document.createElement("div");
      taskList.className = "project-workspace-task-detail-list";
      tasks.forEach((task) => {
        const row = document.createElement("article");
        const taskTitle = document.createElement("b");
        taskTitle.textContent = task.title || "未命名任务";
        const taskDescription = document.createElement("p");
        taskDescription.textContent = task.description || "暂无任务说明";
        const taskMeta = document.createElement("span");
        taskMeta.textContent = `${String(task.status || "todo").toUpperCase()} / 执行人：${(task.assigneeIds || []).map(memberNameById).join(" / ") || "未分配"} / 截止：${formatDate(task.dueDate, "未设置", true)}`;
        row.append(taskTitle, taskDescription, taskMeta);
        taskList.appendChild(row);
      });
      if (!tasks.length) taskList.textContent = "负责人尚未拆分任务";
      taskDetails.append(taskHeading, taskList);
      const updateDetails = document.createElement("section");
      updateDetails.className = "project-workspace-detail-section";
      const updateHeading = document.createElement("h3");
      updateHeading.textContent = "最近完成内容与动态";
      const updateList = document.createElement("div");
      updateList.className = "project-workspace-update-detail-list";
      (workspace.updates || []).slice(0, 12).forEach((update) => {
        const row = document.createElement("article");
        const meta = document.createElement("span");
        meta.textContent = `${update.actor?.name || update.actor?.displayName || update.actor?.username || "成员"} / ${formatDate(update.createdAt, "时间未知")}`;
        const detail = document.createElement("p");
        detail.textContent = update.message || "无内容";
        row.append(meta, detail);
        updateList.appendChild(row);
      });
      if (!(workspace.updates || []).length) updateList.textContent = "暂无项目动态";
      updateDetails.append(updateHeading, updateList);
      const deliverableDetails = document.createElement("section");
      deliverableDetails.className = "project-workspace-detail-section";
      const deliverableHeading = document.createElement("h3");
      const deliverables = Array.isArray(workspace.deliverables) ? workspace.deliverables : [];
      deliverableHeading.textContent = `项目成果 / ${deliverables.length}`;
      const deliverableList = document.createElement("div");
      deliverableList.className = "project-workspace-deliverable-list";
      deliverables.forEach((deliverable) => {
        const row = document.createElement("article");
        const link = document.createElement("a");
        link.href = safeUrl(deliverable.url) || "#";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `${deliverable.title} ↗`;
        const description = document.createElement("p");
        description.textContent = deliverable.description || "暂无说明";
        const meta = document.createElement("span");
        meta.textContent = `${String(deliverable.type || "other").toUpperCase()} / ${deliverable.submittedBy?.name || deliverable.submittedBy?.username || "项目成员"}${deliverable.archivedResourceId ? ` / 已归档：${deliverable.archivedResourceId}` : " / 待归档"}`;
        row.append(link, description, meta);
        if (!deliverable.archivedResourceId && ["owner", "editor"].includes(state.user.role) && canAccessPanel("resources")) {
          const archive = document.createElement("button");
          archive.type = "button";
          archive.className = "small-button";
          archive.textContent = "归档到内部资料";
          archive.addEventListener("click", async () => {
            if (state.contentResourceDraftDirty) {
              setStatus("内部资料存在未保存修改，请先保存后再归档项目成果", true);
              return;
            }
            const defaultPermission = `project.${String(workspace.id).toLowerCase().replace(/[^a-z0-9._-]/g, "-")}`.slice(0, 80);
            const permissionKey = window.prompt("设置资料权限标识；归档后可在资源编辑器继续整理", defaultPermission);
            if (permissionKey === null) return;
            archive.disabled = true;
            try {
              const payload = await api(`/api/admin/project-workspaces/${encodeURIComponent(workspace.id)}/deliverables/${encodeURIComponent(deliverable.id)}/archive`, { method: "POST", body: JSON.stringify({ permissionKey }) });
              Object.assign(workspace, payload.workspace);
              if (Array.isArray(payload.resources)) state.content.resources = payload.resources;
              if (payload.contentMeta) state.content._meta = payload.contentMeta;
              state.contentResourceDraftDirty = false;
              renderProjectWorkspaces();
              if (canAccessPanel("resources")) renderResources();
              setStatus("PROJECT DELIVERABLE ARCHIVED / 已归档到内部资料");
            } catch (error) { setStatus(error.message, true); }
            finally { archive.disabled = false; }
          });
          row.appendChild(archive);
        }
        deliverableList.appendChild(row);
      });
      if (!deliverables.length) deliverableList.textContent = "项目组尚未提交资料、网站或仓库链接";
      deliverableDetails.append(deliverableHeading, deliverableList);
      const allocations = document.createElement("div");
      allocations.className = "project-workspace-allocation-summary";
      (workspace.allocations || []).forEach((allocation) => {
        const row = document.createElement("p");
        const allocated = Number(allocation.allocated) || 0;
        const used = Number(allocation.used) || 0;
        const pending = Number(allocation.pending) || 0;
        const remaining = Number.isFinite(Number(allocation.remaining)) ? Number(allocation.remaining) : Math.max(0, allocated - used - pending);
        const unit = allocation.unit || allocation.currency || allocation.target?.unit || allocation.target?.currency || "";
        row.textContent = `${allocation.targetName || allocation.name || allocation.target?.name || allocation.targetId} / ${String(allocation.type || "resource").toUpperCase()} / ALLOCATED ${allocated} / USED ${used} / PENDING ${pending} / REMAINING ${remaining} ${unit}`;
        allocations.appendChild(row);
      });
      if (!allocations.children.length) allocations.textContent = "NO ALLOCATIONS / 暂无配额";
      const actions = document.createElement("div");
      actions.className = "project-workspace-card-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "small-button";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => {
        populateProjectWorkspaceForm(workspace);
        document.querySelector("#projectWorkspaceForm").scrollIntoView({ behavior: "smooth", block: "start" });
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "删除";
      remove.addEventListener("click", async () => {
        if (!window.confirm(`确认删除项目工作区“${workspace.name}”？`)) return;
        remove.disabled = true;
        try {
          await api(`/api/admin/project-workspaces/${encodeURIComponent(workspace.id)}`, { method: "DELETE" });
          state.projectWorkspaces = state.projectWorkspaces.filter((item) => item.id !== workspace.id);
          if (document.querySelector("#projectWorkspaceForm").elements.id.value === workspace.id) resetProjectWorkspaceForm();
          renderProjectWorkspaces();
          setStatus("PROJECT WORKSPACE DELETED");
        } catch (error) {
          setStatus(error.message, true);
        } finally {
          remove.disabled = false;
        }
      });
      if (["owner", "editor"].includes(state.user.role)) actions.appendChild(edit);
      if (state.user.role === "owner") actions.appendChild(remove);
      article.append(head, people, taskDetails, updateDetails, deliverableDetails, allocations, actions);
      list.appendChild(article);
    });
    if (!state.projectWorkspaces.length) list.textContent = "NO PROJECT WORKSPACES / 暂无项目工作区";
  }

  function renderMail() {
    const configured = Boolean(state.mail?.configured);
    const status = document.querySelector("#mailState");
    status.textContent = configured ? "ONLINE / VERIFIED" : "NOT CONFIGURED";
    status.classList.toggle("is-online", configured);
    document.querySelector("#mailEmail").value = state.mail?.email || state.content.settings.managerEmail || "";
    document.querySelector("#mailSenderName").value = state.mail?.senderName || `${state.content.settings.clubName}运营组`;
    document.querySelector("#mailReplyTo").value = state.mail?.replyTo || state.mail?.email || state.content.settings.managerEmail || "";
    document.querySelector("#mailRecipients").value = (state.mail?.recipients || [state.content.settings.managerEmail].filter(Boolean)).join("\n");
    document.querySelector("#usageApprovedSubject").value = state.mail?.usageApprovedSubject || "";
    document.querySelector("#usageApprovedBody").value = state.mail?.usageApprovedBody || "";
    document.querySelector("#usageRejectedSubject").value = state.mail?.usageRejectedSubject || "";
    document.querySelector("#usageRejectedBody").value = state.mail?.usageRejectedBody || "";
    document.querySelector("#applicationAcceptedSubject").value = state.mail?.applicationAcceptedSubject || "";
    document.querySelector("#applicationAcceptedBody").value = state.mail?.applicationAcceptedBody || "";
    document.querySelector("#applicationRejectedSubject").value = state.mail?.applicationRejectedSubject || "";
    document.querySelector("#applicationRejectedBody").value = state.mail?.applicationRejectedBody || "";
    document.querySelector("#mailAuthCode").placeholder = configured ? "已加密保存，留空可保留当前授权码" : "在 QQ 邮箱设置中生成，不是 QQ 密码";
    document.querySelector("#testMailButton").disabled = !configured;
    const recipientContainer = document.querySelector("#applicationRecipientManagers");
    recipientContainer.replaceChildren();
    const selectedRecipients = new Set(state.mail?.applicationRecipientAdminIds || []);
    state.managers.filter((manager) => manager.status === "active" && manager.email && canAccessPanel("applications", manager)).forEach((manager) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = manager.id;
      input.checked = selectedRecipients.has(manager.id);
      label.append(input, document.createTextNode(`${manager.displayName} / @${manager.username} / ${manager.email} / ${manager.departmentIds.join(", ") || "全部部门"}`));
      recipientContainer.appendChild(label);
    });
  }

  function renderAccessChoices(container, options, selectedValues, name, isOwner) {
    const selected = new Set(selectedValues || []);
    container.replaceChildren();
    options.forEach(([value, labelText]) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = name;
      input.value = value;
      input.checked = isOwner || selected.has(value);
      input.disabled = isOwner;
      label.append(input, document.createTextNode(labelText));
      container.appendChild(label);
    });
  }

  function renderManagerFormAccess() {
    const form = document.querySelector("#managerForm");
    const memberSelect = document.querySelector("#managerMember");
    const selectedMemberId = memberSelect.value;
    const assignedMemberIds = new Set(state.managers.map((manager) => manager.memberId).filter(Boolean));
    memberSelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择现有成员账号";
    memberSelect.appendChild(placeholder);
    state.members.filter((member) => member.status === "active" && !member.mustChangePassword && !assignedMemberIds.has(member.id)).forEach((member) => {
      const option = document.createElement("option");
      option.value = member.id;
      option.textContent = `${member.name} / ${member.username} / ${member.studentId}`;
      memberSelect.appendChild(option);
    });
    memberSelect.value = selectedMemberId;
    const isOwner = form.elements.role.value === "owner";
    renderAccessChoices(document.querySelector("#managerPanelPermissions"), Object.entries(assignablePanels), [], "panelPermissions", isOwner);
    renderAccessChoices(document.querySelector("#managerDepartments"), state.content.departments.map((department) => [department.id, department.name]), [], "departmentIds", isOwner);
  }

  function renderManagers() {
    const list = document.querySelector("#managerList");
    list.replaceChildren();
    state.managers.forEach((manager) => {
      const article = document.createElement("article");
      article.className = "manager-card";
      const identity = document.createElement("div");
      const name = document.createElement("h2");
      name.textContent = manager.displayName;
      const username = document.createElement("code");
      username.textContent = `@${manager.username}${manager.id === state.user.id ? " / CURRENT" : ""}`;
      identity.append(name, username);
      const emailField = document.createElement("label");
      emailField.className = "field";
      emailField.append(document.createTextNode(manager.memberId ? "成员邮箱" : "管理员邮箱"));
      const email = document.createElement("input");
      email.type = "email";
      email.value = manager.email || "";
      email.disabled = Boolean(manager.memberId);
      emailField.appendChild(email);
      const role = document.createElement("select");
      [["owner", "主管理员"], ["editor", "内容编辑"], ["reviewer", "申请审核"]].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = manager.role === value;
        role.appendChild(option);
      });
      const managerStatus = document.createElement("select");
      [["active", "账号启用"], ["disabled", "账号停用"]].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = manager.status === value;
        managerStatus.appendChild(option);
      });
      managerStatus.disabled = manager.id === state.user.id;
      const actions = document.createElement("div");
      actions.className = "manager-card__actions";
      const accessEditor = document.createElement("div");
      accessEditor.className = "manager-access-editor";
      const panelFieldset = document.createElement("fieldset");
      panelFieldset.className = "manager-access-field";
      const panelLegend = document.createElement("legend");
      panelLegend.textContent = "可管理模块";
      const panelChoices = document.createElement("div");
      panelChoices.className = "manager-choice-grid";
      panelFieldset.append(panelLegend, panelChoices);
      const departmentFieldset = document.createElement("fieldset");
      departmentFieldset.className = "manager-access-field";
      const departmentLegend = document.createElement("legend");
      departmentLegend.textContent = "负责部门";
      const departmentChoices = document.createElement("div");
      departmentChoices.className = "manager-choice-grid";
      departmentFieldset.append(departmentLegend, departmentChoices);
      accessEditor.append(panelFieldset, departmentFieldset);
      const renderAccess = () => {
        const isOwner = role.value === "owner";
        renderAccessChoices(panelChoices, Object.entries(assignablePanels), manager.panelPermissions, "panelPermissions", isOwner);
        renderAccessChoices(departmentChoices, state.content.departments.map((department) => [department.id, department.name]), manager.departmentIds, "departmentIds", isOwner);
      };
      renderAccess();
      role.addEventListener("change", renderAccess);
      const save = document.createElement("button");
      save.type = "button";
      save.className = "small-button";
      save.textContent = "保存管理范围";
      save.addEventListener("click", async () => {
        try {
          const panelPermissions = [...panelChoices.querySelectorAll("input:checked")].map((input) => input.value);
          const departmentIds = [...departmentChoices.querySelectorAll("input:checked")].map((input) => input.value);
          const payload = await api(`/api/admin/managers/${encodeURIComponent(manager.id)}`, { method: "PATCH", body: JSON.stringify({ email: email.value, role: role.value, status: managerStatus.value, panelPermissions, departmentIds }) });
          Object.assign(manager, payload.manager);
          renderAccess();
          setStatus("MANAGER UPDATED");
        } catch (error) { setStatus(error.message, true); role.value = manager.role; }
      });
      actions.appendChild(save);
      if (!manager.memberId) {
        const password = document.createElement("button");
        password.type = "button";
        password.className = "small-button";
        password.textContent = "重置密码";
        password.addEventListener("click", async () => {
          const nextPassword = window.prompt(`为 ${manager.username} 设置新密码（至少 8 位）`);
          if (!nextPassword) return;
          try {
            await api(`/api/admin/managers/${encodeURIComponent(manager.id)}`, { method: "PATCH", body: JSON.stringify({ password: nextPassword }) });
            setStatus("PASSWORD UPDATED");
          } catch (error) { setStatus(error.message, true); }
        });
        actions.appendChild(password);
      }
      if (manager.id !== state.user.id) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "danger-button";
        remove.textContent = "删除";
        remove.addEventListener("click", async () => {
          if (!window.confirm(`确认删除管理员 ${manager.username}？`)) return;
          try {
             await api(`/api/admin/managers/${encodeURIComponent(manager.id)}`, { method: "DELETE" });
             state.managers = state.managers.filter((item) => item.id !== manager.id);
             renderManagers();
             renderManagerFormAccess();
          } catch (error) { setStatus(error.message, true); }
        });
        actions.appendChild(remove);
      }
      article.append(identity, emailField, role, managerStatus, actions, accessEditor);
      list.appendChild(article);
    });
  }

  function renderMembers() {
    const departmentSelect = document.querySelector("#memberDepartment");
    departmentSelect.replaceChildren();
    state.content.departments.forEach((department) => {
      const option = document.createElement("option");
      option.value = department.id;
      option.textContent = department.name;
      departmentSelect.appendChild(option);
    });
    const list = document.querySelector("#memberList");
    list.replaceChildren();
    state.members.forEach((member) => {
      const article = document.createElement("article");
      article.className = "manager-card member-card";
      const identity = document.createElement("div");
      const name = document.createElement("h2");
      name.textContent = member.name;
      const username = document.createElement("code");
      username.textContent = `@${member.username}`;
      identity.append(name, username);
      const contact = document.createElement("p");
      const department = state.content.departments.find((item) => item.id === member.departmentId);
      contact.textContent = `${department?.name || member.departmentId || "未分配部门"}\n学号：${member.studentId || "未填写"}\n班级：${member.className || "未填写"}\n${member.email || member.contact || "未填写联系方式"}\n账号状态：${member.mustChangePassword ? "等待激活" : "已激活"}`;
      const access = document.createElement("div");
      const status = document.createElement("select");
      [["active", "正常"], ["suspended", "已停用"]].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = member.status === value;
        status.appendChild(option);
      });
      const permissions = document.createElement("input");
      permissions.value = (member.permissions || []).join(", ");
      permissions.placeholder = "resource.basic, project.internal";
      access.append(status, permissions);
      const actions = document.createElement("div");
      actions.className = "manager-card__actions";
      if (["owner", "editor"].includes(state.user.role)) {
        const save = document.createElement("button");
        save.type = "button";
        save.className = "small-button";
        save.textContent = "保存权限";
        save.addEventListener("click", async () => {
          try {
            const payload = await api(`/api/admin/members/${encodeURIComponent(member.id)}`, { method: "PATCH", body: JSON.stringify({ status: status.value, permissions: permissions.value.split(",").map((item) => item.trim()).filter(Boolean) }) });
            Object.assign(member, payload.member);
            syncWorkspaceMemberOption(payload.member);
            setStatus("MEMBER ACCESS UPDATED");
          } catch (error) { setStatus(error.message, true); }
        });
        const credentialAction = document.createElement("button");
        credentialAction.type = "button";
        credentialAction.className = "small-button";
        credentialAction.textContent = member.mustChangePassword ? "重新签发激活码" : "重置密码";
        credentialAction.addEventListener("click", async () => {
          if (member.mustChangePassword) {
            try {
              const payload = await api(`/api/admin/members/${encodeURIComponent(member.id)}/activation-code`, { method: "POST", body: "{}" });
              window.prompt(`一次性激活码${payload.activationNotified ? "（已发送邮箱）" : "（请转交成员）"}`, payload.activationCode);
            } catch (error) { setStatus(error.message, true); }
            return;
          }
          const password = window.prompt(`为成员 ${member.username} 设置新密码（至少 8 位）`);
          if (!password) return;
          try { await api(`/api/admin/members/${encodeURIComponent(member.id)}`, { method: "PATCH", body: JSON.stringify({ password }) }); setStatus("MEMBER PASSWORD UPDATED"); }
          catch (error) { setStatus(error.message, true); }
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "danger-button";
        remove.textContent = "删除";
        remove.addEventListener("click", async () => {
          if (!window.confirm(`确认删除成员 ${member.name}？`)) return;
          try { await api(`/api/admin/members/${encodeURIComponent(member.id)}`, { method: "DELETE" }); state.members = state.members.filter((item) => item.id !== member.id); renderMembers(); }
          catch (error) { setStatus(error.message, true); }
        });
        actions.append(save, credentialAction);
        if (state.user.role === "owner") actions.appendChild(remove);
      }
      article.append(identity, contact, access, actions);
      list.appendChild(article);
    });
    if (!state.members.length) list.textContent = "NO MEMBERS / 暂无成员档案";
  }

  function renderNotifications() {
    const departments = document.querySelector("#notificationDepartments");
    departments.replaceChildren();
    state.content.departments.forEach((department) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "departmentIds";
      input.value = department.id;
      label.append(input, document.createTextNode(` ${department.name}`));
      departments.appendChild(label);
    });
    const members = document.querySelector("#notificationMembers");
    members.replaceChildren();
    state.notificationAudience.members.forEach((member) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "memberIds";
      input.value = member.id;
      label.append(input, document.createTextNode(` ${member.name} / ${member.email}`));
      members.appendChild(label);
    });
    if (!members.children.length) members.textContent = "暂无具有邮箱的有效成员";
    const applicants = document.querySelector("#notificationApplicants");
    applicants.replaceChildren();
    state.notificationAudience.applicants.forEach((application) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "applicationIds";
      input.value = application.id;
      input.checked = application.id === state.requestedApplicantId;
      label.append(input, document.createTextNode(` ${application.name} / ${application.email} / ${application.departmentName} / ${application.status}`));
      applicants.appendChild(label);
    });
    state.requestedApplicantId = "";
    if (!applicants.children.length) applicants.textContent = "暂无具有邮箱的未转成员申请人";
    renderMemberMessageAdminList();
    renderNotificationHistory();
    updateNotificationSummary();
  }

  function renderNotificationHistory() {
    const history = document.querySelector("#notificationHistory");
    history.replaceChildren();
    state.notifications.forEach((notification) => {
      const article = document.createElement("article");
      article.className = "notification-record";
      const time = document.createElement("time");
      time.textContent = new Date(notification.sentAt).toLocaleString("zh-CN");
      const content = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = notification.subject;
      const message = document.createElement("p");
      message.textContent = `${notification.message.slice(0, 140)}${notification.message.length > 140 ? "..." : ""}`;
      content.append(title, message);
      const count = document.createElement("code");
      count.textContent = `${notification.recipientCount} RECIPIENTS\n${notification.sentBy?.displayName || notification.sentBy?.username || "SYSTEM"}`;
      article.append(time, content, count);
      history.appendChild(article);
    });
    if (!state.notifications.length) history.textContent = "NO NOTIFICATIONS SENT";
  }

  function renderMemberMessageAdminList() {
    const list = document.querySelector("#memberMessageAdminList");
    list.replaceChildren();
    state.memberMessages.forEach((thread) => {
      const article = document.createElement("article");
      article.className = "notification-record";
      const content = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = `${thread.memberName} / ${thread.subject}`;
      const detail = document.createElement("p");
      detail.textContent = `${thread.message}\n\n${(thread.replies || []).map((reply) => `${reply.sender === "member" || reply.member ? thread.memberName : reply.admin?.displayName || "管理员"}：${reply.message}`).join("\n") || "尚未回复"}`;
      content.append(title, detail);
      const actions = document.createElement("div");
      const meta = document.createElement("code");
      meta.textContent = `${thread.id}\n${thread.status === "closed" ? "CLOSED" : "OPEN"}`;
      const reply = document.createElement("textarea");
      reply.placeholder = "回复成员";
      reply.maxLength = 5000;
      const sendReply = async (close) => {
        if (reply.value.trim().length < 2) { setStatus("请填写回复内容", true); return; }
        try {
          const payload = await api(`/api/admin/member-messages/${encodeURIComponent(thread.id)}/replies`, { method: "POST", body: JSON.stringify({ message: reply.value, close }) });
          Object.assign(thread, payload.thread);
          renderMemberMessageAdminList();
          setStatus(payload.notified ? "REPLY SENT / MEMBER EMAILED" : "REPLY SAVED / MEMBER EMAIL NOT SENT", !payload.notified);
        } catch (error) { setStatus(error.message, true); }
      };
      const replyButton = document.createElement("button");
      replyButton.type = "button";
      replyButton.className = "small-button";
      replyButton.textContent = "回复";
      replyButton.addEventListener("click", () => sendReply(false));
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "small-button";
      closeButton.textContent = "回复并结束";
      closeButton.addEventListener("click", () => sendReply(true));
      actions.appendChild(meta);
      if (thread.status !== "closed") actions.append(reply, replyButton, closeButton);
      article.append(content, actions);
      list.appendChild(article);
    });
    if (!state.memberMessages.length) list.textContent = "NO MEMBER QUESTIONS / 暂无成员问询";
  }

  function renderBugReports() {
    const list = document.querySelector("#bugReportList");
    list.replaceChildren();
    (state.bugReports || []).forEach((report) => {
      const article = document.createElement("article");
      article.className = "notification-record";
      const content = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = report.title;
      const detail = document.createElement("p");
      detail.textContent = `${report.description}\n${report.contact ? `联系方式：${report.contact}` : "未留联系方式"}`;
      content.append(title, detail);
      const actions = document.createElement("div");
      const meta = document.createElement("code");
      meta.textContent = `${report.id}\n${new Date(report.createdAt).toLocaleString("zh-CN")}\n${report.status === "open" ? "未处理" : "已解决"}`;
      if (report.status === "open") {
        const resolveButton = document.createElement("button");
        resolveButton.type = "button";
        resolveButton.className = "small-button";
        resolveButton.textContent = "标记已解决";
        resolveButton.addEventListener("click", async () => {
          try {
            await api(`/api/admin/bug-reports/${report.id}`, { method: "PATCH", body: JSON.stringify({ status: "resolved" }) });
            report.status = "resolved";
            renderBugReports();
          } catch (error) { setStatus(error.message, true); }
        });
        actions.append(meta, resolveButton);
      } else {
        actions.appendChild(meta);
      }
      article.append(content, actions);
      list.appendChild(article);
    });
    if (!(state.bugReports || []).length) list.textContent = "NO BUG REPORTS / 暂无 Bug 反馈";
  }

  function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  const projectMediaTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "video/mp4", "video/webm"]);

  function readMediaMetadata(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const media = file.type.startsWith("image/") ? new Image() : document.createElement("video");
      const finish = (metadata = {}) => {
        URL.revokeObjectURL(url);
        resolve(metadata);
      };
      media.addEventListener(file.type.startsWith("image/") ? "load" : "loadedmetadata", () => finish({
        width: media.naturalWidth || media.videoWidth || 0,
        height: media.naturalHeight || media.videoHeight || 0,
        duration: Number(media.duration) || 0
      }), { once: true });
      media.addEventListener("error", () => finish(), { once: true });
      media.src = url;
    });
  }

  async function inspectProjectMedia(file) {
    const errors = [];
    const warnings = [];
    if (!projectMediaTypes.has(file.type)) errors.push("不支持此文件类型");
    if (file.size > 100 * 1024 * 1024) errors.push("超过 100MB 上限");
    if (!/^[A-Za-z0-9_-]+-(?:poster|demo|process)-v\d+\.(?:jpe?g|png|webp|avif|mp4|webm)$/i.test(file.name)) warnings.push("建议按“项目编号-用途-版本”命名");
    const metadata = errors.length ? {} : await readMediaMetadata(file);
    if (file.type.startsWith("image/")) {
      if (!metadata.width || !metadata.height) errors.push("无法读取图片尺寸");
      else {
        if (metadata.width < 1200) warnings.push("图片宽度低于 1200px");
        const ratio = metadata.width / metadata.height;
        if (ratio < 1.4 || ratio > 1.9) warnings.push("海报建议使用 16:10 或 16:9 横图");
      }
      if (file.type === "image/jpeg" || file.type === "image/png") warnings.push("建议转为 WebP 或 AVIF 以减小体积");
    } else if (file.type.startsWith("video/")) {
      if (!metadata.width || !metadata.height) errors.push("无法读取视频信息");
      else if (metadata.width < 1280 || metadata.height < 720) warnings.push("视频分辨率低于 720p");
      if (metadata.duration > 90) warnings.push("视频超过 90 秒，建议剪辑展示版");
    }
    return { file, errors, warnings, metadata };
  }

  function renderUploadQueueItem(result, status = "ready", detail = "") {
    const row = document.createElement("div");
    row.className = `upload-queue__item${status === "uploading" ? " is-uploading" : status === "complete" ? " is-complete" : status === "error" ? " is-error" : ""}`;
    const title = document.createElement("strong");
    title.textContent = result.file.name;
    const stateLabel = document.createElement("span");
    stateLabel.textContent = status === "uploading" ? "上传中" : status === "complete" ? "已完成" : status === "error" ? "需修正" : "等待上传";
    const description = document.createElement("p");
    const dimensions = result.metadata?.width ? ` / ${result.metadata.width}×${result.metadata.height}${result.metadata.duration ? ` / ${Math.round(result.metadata.duration)} 秒` : ""}` : "";
    description.textContent = detail || `${formatFileSize(result.file.size)}${dimensions}${result.warnings.length ? ` / 提示：${result.warnings.join("；")}` : ""}`;
    row.append(title, stateLabel, description);
    return row;
  }

  function renderUploads() {
    const library = document.querySelector("#uploadLibrary");
    library.replaceChildren();
    state.uploads.forEach((file) => {
      const card = document.createElement("article");
      card.className = "upload-card";
      const preview = document.createElement("div");
      preview.className = "upload-card__preview";
      if (file.mime.startsWith("image/")) {
        const image = document.createElement("img");
        image.src = file.url;
        image.alt = file.originalName;
        image.loading = "lazy";
        preview.appendChild(image);
      } else if (file.mime.startsWith("video/")) {
        const video = document.createElement("video");
        video.src = file.url;
        video.controls = true;
        video.preload = "metadata";
        preview.appendChild(video);
      }
      const title = document.createElement("h3");
      title.textContent = file.originalName;
      const meta = document.createElement("p");
      meta.textContent = `${file.fileName}\n${file.mime} / ${formatFileSize(file.size)}\n${formatDate(file.createdAt)}${file.uploadedBy ? ` / ${file.uploadedBy.displayName || file.uploadedBy.username}` : ""}`;
      const actions = document.createElement("div");
      actions.className = "upload-card__actions";
      const view = document.createElement("a");
      view.href = file.url;
      view.target = "_blank";
      view.rel = "noopener";
      view.textContent = "查看";
      const download = document.createElement("a");
      download.href = file.url;
      download.download = file.originalName || file.fileName;
      download.textContent = "下载";
      actions.append(view, download);
      card.append(preview, title, meta, actions);
      library.appendChild(card);
    });
    if (!state.uploads.length) library.textContent = "NO UPLOADED FILES / 暂无上传文件";
  }

  function updateNotificationSummary() {
    const form = document.querySelector("#notificationForm");
    const allMembers = form.elements.allMembers.checked;
    const allApplicants = form.elements.allApplicants.checked;
    const selectedMembers = form.querySelectorAll('[name="memberIds"]:checked').length;
    const selectedApplicants = form.querySelectorAll('[name="applicationIds"]:checked').length;
    const selectedDepartments = form.querySelectorAll('[name="departmentIds"]:checked').length;
    const permissionKeys = form.elements.permissionKeys.value.split(",").map((item) => item.trim()).filter(Boolean).length;
    const customEmails = form.elements.customEmails.value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean).length;
    document.querySelector("#notificationSummary").textContent = `AUDIENCE / ${allMembers ? `ALL MEMBERS ${state.notificationAudience.members.length}` : `MEMBERS ${selectedMembers}`} / ${allApplicants ? `ALL APPLICANTS ${state.notificationAudience.applicants.length}` : `APPLICANTS ${selectedApplicants}`} / DEPARTMENTS ${selectedDepartments} / PERMISSIONS ${permissionKeys} / CUSTOM ${customEmails}${form.elements.includeManagers.checked ? " / MANAGERS" : ""}${form.elements.includeDefaultRecipients.checked ? " / DEFAULT GROUP" : ""}`;
  }

  function renderInventoryImportPreview(payload) {
    const container = document.querySelector("#inventoryImportPreview");
    const errorsByRow = new Map((payload.errors || []).map((error) => [error.row, error.messages || []]));
    container.replaceChildren();
    (payload.rows || []).slice(0, 100).forEach((item) => {
      const row = document.createElement("div");
      row.className = `inventory-import-row${errorsByRow.has(item.row) ? " is-error" : ""}`;
      const rowNumber = document.createElement("span");
      rowNumber.textContent = `#${item.row}`;
      const name = document.createElement("b");
      name.textContent = `${item.name || "未命名"}${item.sku ? ` / ${item.sku}` : ""}`;
      const quantity = document.createElement("span");
      quantity.textContent = `${item.quantity} ${item.unit || "-"}`;
      const cost = document.createElement("span");
      cost.textContent = `¥ ${Number(item.unitCost || 0).toFixed(2)}`;
      const location = document.createElement("span");
      location.textContent = errorsByRow.has(item.row) ? errorsByRow.get(item.row).join("；") : item.location || "不发送领取位置";
      row.append(rowNumber, name, quantity, cost, location);
      container.appendChild(row);
    });
    if ((payload.rows || []).length > 100) {
      const more = document.createElement("p");
      more.textContent = `仅展示前 100 行，另有 ${payload.rows.length - 100} 行将在确认后导入。`;
      container.appendChild(more);
    }
  }

  async function parseInventoryImport(commit = false) {
    const fileInput = document.querySelector("#inventoryImportFile");
    const message = document.querySelector("#inventoryImportMessage");
    const commitButton = document.querySelector("#commitInventoryImport");
    const selectedFile = fileInput.files[0];
    const generation = inventoryImportGeneration;
    if (!selectedFile) { message.textContent = "请选择表格文件"; return null; }
    const body = new FormData();
    body.append("file", selectedFile);
    message.textContent = commit ? "IMPORTING / 正在写入库存..." : "PARSING / 正在解析并校验...";
    const payload = await api(`/api/admin/inventory/import?commit=${commit}`, { method: "POST", body });
    if (!commit) {
      if (generation !== inventoryImportGeneration || fileInput.files[0] !== selectedFile) return null;
      renderInventoryImportPreview(payload);
      inventoryImportReady = payload.ok && payload.count > 0;
      commitButton.disabled = !inventoryImportReady;
      message.textContent = payload.errors?.length ? `发现 ${payload.errors.length} 行错误，请修正表格后重新预览` : `解析成功：${payload.count} 行物资可以导入`;
    }
    return payload;
  }

  function renderInventory() {
    const list = document.querySelector("#inventoryList");
    const search = document.querySelector("#inventorySearch");
    const categorySelect = document.querySelector("#inventoryCategory");
    const count = document.querySelector("#inventoryCount");
    const categories = [...new Set(state.inventory.items.map((item) => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const selectedCategory = categorySelect.value;
    categorySelect.replaceChildren(new Option("全部分类", ""), ...categories.map((category) => new Option(category, category)));
    categorySelect.value = categories.includes(selectedCategory) ? selectedCategory : "";
    const query = search.value.trim().toLocaleLowerCase("zh-CN");
    const filteredItems = state.inventory.items.filter((item) => {
      if (categorySelect.value && item.category !== categorySelect.value) return false;
      return !query || [item.name, item.sku, item.category, item.location, item.storageLocation?.label].some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(query));
    });
    count.textContent = `${filteredItems.length} / ${state.inventory.items.length} ITEMS`;
    list.replaceChildren();
    filteredItems.forEach((item) => {
      const article = document.createElement("article");
      article.className = "inventory-card";
      const code = document.createElement("span");
      code.textContent = `[ ${item.sku || item.id} / ${item.category || "UNCATEGORIZED"} ]`;
      const title = document.createElement("h3");
      title.textContent = item.name;
      const media = document.createElement("div");
      media.className = "inventory-card__media";
      [["componentImage", "元器件图片"], ["locationImage", "领取位置图片"]].forEach(([field, labelText]) => {
        const url = safeUrl(item[field]);
        if (!url) return;
        const view = document.createElement("button");
        view.type = "button";
        view.title = `查看${labelText}`;
        const image = document.createElement("img");
        image.src = url;
        image.alt = `${item.name} ${labelText}`;
        const label = document.createElement("span");
        label.textContent = labelText;
        view.append(image, label);
        view.addEventListener("click", () => openImageViewer(url, `${item.name} / ${labelText}`));
        media.appendChild(view);
      });
      const meta = document.createElement("p");
      meta.textContent = `${item.location || "未设置位置"}\n单位成本：${Number(item.unitCost || 0).toFixed(2)}`;
      const value = document.createElement("div");
      value.className = "inventory-value";
      value.textContent = Number(item.quantity).toLocaleString("zh-CN");
      const unit = document.createElement("small");
      unit.textContent = ` ${item.unit}`;
      value.appendChild(unit);
      const actions = document.createElement("div");
      actions.className = "inventory-actions";
      if (["owner", "editor"].includes(state.user.role)) {
        const manageImage = (field, labelText) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "small-button";
          button.textContent = item[field] ? `替换${labelText}` : `上传${labelText}`;
          button.addEventListener("click", () => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/jpeg,image/png,image/webp,image/avif";
            input.addEventListener("change", async () => {
              if (!input.files[0]) return;
              button.disabled = true;
              try {
                const payload = await queueInventoryImageMutation(item.id, field, async () => {
                  const uploaded = await uploadInventoryImage(input.files[0]);
                  return api(`/api/admin/inventory/${item.id}`, { method: "PATCH", body: JSON.stringify({ [field]: uploaded.url }) });
                });
                Object.assign(item, payload.item);
                renderInventory();
                setStatus(`${labelText}已更新`);
              } catch (error) { setStatus(error.message, true); }
              finally { button.disabled = false; }
            }, { once: true });
            input.click();
          });
          actions.appendChild(button);
          if (item[field]) {
            const clear = document.createElement("button");
            clear.type = "button";
            clear.className = "small-button";
            clear.textContent = `清除${labelText}`;
            clear.addEventListener("click", async () => {
              clear.disabled = true;
              try {
                const payload = await queueInventoryImageMutation(item.id, field, () => api(`/api/admin/inventory/${item.id}`, { method: "PATCH", body: JSON.stringify({ [field]: "" }) }));
                Object.assign(item, payload.item);
                renderInventory();
                setStatus(`${labelText}已从当前库存记录清除`);
              } catch (error) { setStatus(error.message, true); }
              finally { clear.disabled = false; }
            });
            actions.appendChild(clear);
          }
        };
        manageImage("componentImage", "元器件图");
        manageImage("locationImage", "位置图");
        const editLocation = document.createElement("button");
        editLocation.type = "button";
        editLocation.className = "small-button";
        editLocation.textContent = "编辑位置";
        editLocation.addEventListener("click", async () => {
          const current = item.storageLocation || {};
          const container = window.prompt("收纳容器（全部留空可清除领取位置）", current.container || "收纳盒");
          if (container === null) return;
          const label = window.prompt("位置标签，例如传感器 / 核心板", current.label || "");
          if (label === null) return;
          const row = window.prompt("行号：1 / 2 / 3 / 4", current.row || "");
          if (row === null) return;
          const column = window.prompt("列标签或编号", current.column || "");
          if (column === null) return;
          editLocation.disabled = true;
          try {
            const payload = await api(`/api/admin/inventory/${item.id}`, { method: "PATCH", body: JSON.stringify({ storageLocation: { container, label, row, column } }) });
            Object.assign(item, payload.item);
            renderInventory();
            setStatus(item.location ? `位置已更新：${item.location}` : "物资领取位置已清除");
          } catch (error) { setStatus(error.message, true); }
          finally { editLocation.disabled = false; }
        });
        const archive = document.createElement("button");
        archive.type = "button";
        archive.className = "small-button";
        archive.textContent = item.status === "active" ? "归档" : "重新启用";
        archive.addEventListener("click", async () => {
          archive.disabled = true;
          try {
            const payload = await api(`/api/admin/inventory/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: item.status === "active" ? "archived" : "active" }) });
            Object.assign(item, payload.item);
            renderInventory();
          } catch (error) { setStatus(error.message, true); }
          finally { archive.disabled = false; }
        });
        const restock = document.createElement("button");
        restock.type = "button";
        restock.className = "small-button";
        restock.textContent = "入库";
        restock.addEventListener("click", async () => {
          const quantity = window.prompt(`输入 ${item.name} 的入库数量`);
          if (!quantity) return;
          const reason = window.prompt("入库原因 / 来源");
          if (!reason) return;
          restock.disabled = true;
          try { const payload = await api(`/api/admin/inventory/${item.id}/restock`, { method: "POST", body: JSON.stringify({ quantity, reason }) }); Object.assign(item, payload.item); state.inventory = await api("/api/admin/inventory"); renderInventory(); }
          catch (error) { setStatus(error.message, true); }
          finally { restock.disabled = false; }
        });
        actions.append(editLocation, archive, restock);
        if (state.user.role === "owner") {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "danger-button";
          remove.textContent = "删除";
          remove.addEventListener("click", async () => {
            if (!window.confirm(`确认删除材料“${item.name}”？剩余 ${item.quantity} ${item.unit} 将记为库存核销，历史流水会保留。`)) return;
            remove.disabled = true;
            try {
              await api(`/api/admin/inventory/${item.id}`, { method: "DELETE" });
              state.inventory = await api("/api/admin/inventory");
              renderInventory();
              setStatus("MATERIAL DELETED / LEDGER PRESERVED");
            } catch (error) { setStatus(error.message, true); }
            finally { remove.disabled = false; }
          });
          actions.appendChild(remove);
        }
      }
      article.append(code, title, media, meta, value, actions);
      list.appendChild(article);
    });
    if (!filteredItems.length) list.textContent = state.inventory.items.length ? "NO MATCHING MATERIALS / 没有匹配物资" : "NO MATERIALS / 暂无物资";
    renderLedger(document.querySelector("#inventoryLedger"), state.inventory.ledger, "quantity", "unit");
  }

  function renderFunds() {
    const list = document.querySelector("#fundList");
    list.replaceChildren();
    state.funds.accounts.forEach((account) => {
      const article = document.createElement("article");
      article.className = "inventory-card";
      const code = document.createElement("span");
      code.textContent = `[ ${account.currency} / ${account.status.toUpperCase()} ]`;
      const title = document.createElement("h3");
      title.textContent = account.name;
      const meta = document.createElement("p");
      meta.textContent = account.notes || "无备注";
      const value = document.createElement("div");
      value.className = "inventory-value";
      value.textContent = Number(account.balance).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const currency = document.createElement("small");
      currency.textContent = ` ${account.currency}`;
      value.appendChild(currency);
      const actions = document.createElement("div");
      actions.className = "inventory-actions";
      if (state.user.role === "owner") {
        const archive = document.createElement("button");
        archive.type = "button";
        archive.className = "small-button";
        archive.textContent = account.status === "active" ? "归档" : "重新启用";
        archive.addEventListener("click", async () => {
          archive.disabled = true;
          try {
            const payload = await api(`/api/admin/funds/${account.id}`, { method: "PATCH", body: JSON.stringify({ status: account.status === "active" ? "archived" : "active" }) });
            Object.assign(account, payload.account);
            renderFunds();
          } catch (error) { setStatus(error.message, true); }
          finally { archive.disabled = false; }
        });
        const topup = document.createElement("button");
        topup.type = "button";
        topup.className = "small-button";
        topup.textContent = "入账";
        topup.addEventListener("click", async () => {
          const amount = window.prompt(`输入 ${account.name} 的入账金额`);
          if (!amount) return;
          const reason = window.prompt("入账来源 / 原因");
          if (!reason) return;
          topup.disabled = true;
          try { const payload = await api(`/api/admin/funds/${account.id}/topup`, { method: "POST", body: JSON.stringify({ amount, reason }) }); Object.assign(account, payload.account); state.funds = await api("/api/admin/funds"); renderFunds(); }
          catch (error) { setStatus(error.message, true); }
          finally { topup.disabled = false; }
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "danger-button";
        remove.textContent = "删除";
        remove.addEventListener("click", async () => {
          if (!window.confirm(`确认删除资金账户“${account.name}”？剩余 ${Number(account.balance).toFixed(2)} ${account.currency} 将记为余额核销，历史流水会保留。`)) return;
          remove.disabled = true;
          try {
            await api(`/api/admin/funds/${account.id}`, { method: "DELETE" });
            state.funds = await api("/api/admin/funds");
            renderFunds();
            setStatus("FUND ACCOUNT DELETED / LEDGER PRESERVED");
          } catch (error) { setStatus(error.message, true); }
          finally { remove.disabled = false; }
        });
        actions.append(archive, topup, remove);
      }
      article.append(code, title, meta, value, actions);
      list.appendChild(article);
    });
    if (!state.funds.accounts.length) list.textContent = "NO FUND ACCOUNTS / 暂无资金账户";
    renderLedger(document.querySelector("#fundLedger"), state.funds.ledger, "amount", "currency");
  }

  function renderLedger(container, entries, valueField, unitField) {
    container.replaceChildren();
    entries.slice(0, 100).forEach((entry) => {
      const row = document.createElement("article");
      row.className = "audit-row";
      const time = document.createElement("time");
      time.textContent = new Date(entry.createdAt).toLocaleString("zh-CN");
      const name = document.createElement("b");
      name.textContent = entry.itemName || entry.accountName;
      const detail = document.createElement("span");
      detail.textContent = `${entry.direction === "in" ? "+" : "-"}${entry[valueField]} ${entry[unitField]} / ${entry.reason}`;
      const actor = document.createElement("code");
      actor.textContent = entry.actor?.displayName || entry.memberId || "SYSTEM";
      row.append(time, name, detail, actor);
      container.appendChild(row);
    });
    if (!entries.length) container.textContent = "NO LEDGER ENTRIES";
  }

  function renderUsageRequests() {
    const list = document.querySelector("#usageRequestList");
    const pending = state.usageRequests.filter((item) => item.status === "pending").length;
    document.querySelector("#usageBadge").textContent = pending;
    list.replaceChildren();
    state.usageRequests.forEach((usageRequest) => {
      const article = document.createElement("article");
      article.className = "usage-card";
      const identity = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = usageRequest.memberName;
      const code = document.createElement("code");
      code.textContent = `${usageRequest.id}\n${new Date(usageRequest.createdAt).toLocaleString("zh-CN")}`;
      identity.append(title, code);
      const target = document.createElement("p");
      target.textContent = `${usageRequest.type === "material" ? "材料" : "资金"}\n${usageRequest.targetName}\n${usageRequest.type === "material" ? `${usageRequest.quantity} ${usageRequest.unit}` : `${Number(usageRequest.amount).toFixed(2)} ${usageRequest.currency}`}${usageRequest.projectWorkspaceName ? `\n项目：${usageRequest.projectWorkspaceName}` : ""}`;
      const purpose = document.createElement("p");
      purpose.textContent = `${usageRequest.purpose}\n\n状态：${usageRequest.status}${usageRequest.reviewNote ? `\n意见：${usageRequest.reviewNote}` : ""}${usageRequest.pickupInstruction ? `\n领取：${usageRequest.pickupInstruction}` : ""}`;
      purpose.classList.add(`status-${usageRequest.status}`);
      const actions = document.createElement("div");
      actions.className = "usage-card__actions";
      [[usageRequest.componentImage, "查看元器件图"], [usageRequest.locationImage, "查看位置图"]].forEach(([value, label]) => {
        const url = safeUrl(value);
        if (!url) return;
        const view = document.createElement("button");
        view.type = "button";
        view.className = "small-button";
        view.textContent = label;
        view.addEventListener("click", () => openImageViewer(url, `${usageRequest.targetName} / ${label}`));
        actions.appendChild(view);
      });
      if (usageRequest.status === "pending" && ["owner", "reviewer"].includes(state.user.role)) {
        const note = document.createElement("textarea");
        note.placeholder = "审批意见（可选）";
        const approve = document.createElement("button");
        approve.type = "button";
        approve.className = "small-button";
        approve.textContent = "批准并执行";
        const reject = document.createElement("button");
        reject.type = "button";
        reject.className = "danger-button";
        reject.textContent = "拒绝";
        const decide = async (decision) => {
          approve.disabled = true;
          reject.disabled = true;
          let committed = false;
          try {
            const payload = await api(`/api/admin/usage-requests/${usageRequest.id}`, { method: "PATCH", body: JSON.stringify({ decision, reviewNote: note.value }) });
            Object.assign(usageRequest, payload.request);
            committed = true;
            renderUsageRequests();
            setStatus(payload.notified ? "DECISION SAVED / RESULT EMAIL SENT" : "DECISION SAVED / RESULT EMAIL NOT SENT", !payload.notified);
            const refreshes = [];
            if (canAccessPanel("inventory")) refreshes.push(api("/api/admin/inventory").then((value) => { state.inventory = value; renderInventory(); }));
            if (canAccessPanel("funds")) refreshes.push(api("/api/admin/funds").then((value) => { state.funds = value; renderFunds(); }));
            const results = await Promise.allSettled(refreshes);
            if (results.some((result) => result.status === "rejected")) setStatus("DECISION SAVED / 资源列表刷新失败", true);
          }
          catch (error) { setStatus(error.message, true); }
          finally {
            approve.disabled = committed;
            reject.disabled = committed;
          }
        };
        approve.addEventListener("click", () => decide("approved"));
        reject.addEventListener("click", () => decide("rejected"));
        actions.append(note, approve, reject);
      }
      article.append(identity, target, purpose, actions);
      list.appendChild(article);
    });
    if (!state.usageRequests.length) list.textContent = "NO USAGE REQUESTS / 暂无使用申请";
  }

  function renderAudit() {
    const list = document.querySelector("#auditList");
    list.replaceChildren();
    state.audit.forEach((entry) => {
      const row = document.createElement("article");
      row.className = "audit-row";
      const time = document.createElement("time");
      time.textContent = new Date(entry.timestamp).toLocaleString("zh-CN");
      const actor = document.createElement("b");
      actor.textContent = entry.actor?.displayName || entry.actor?.username || "SYSTEM";
      const action = document.createElement("span");
      action.textContent = `${entry.action} / ${entry.target}`;
      const source = document.createElement("code");
      source.textContent = entry.source;
      row.append(time, actor, action, source);
      list.appendChild(row);
    });
    if (!state.audit.length) list.textContent = "NO OPERATIONS RECORDED";
  }

  function applyRoleAccess() {
    const role = state.user.role;
    document.querySelectorAll("[data-owner-only]").forEach((element) => {
      element.hidden = role !== "owner";
      element.querySelectorAll("input,textarea,select,button").forEach((control) => { control.disabled = role !== "owner"; if (role !== "owner" && control.type === "checkbox") control.checked = false; });
    });
    document.querySelectorAll("[data-inventory-edit]").forEach((element) => { element.hidden = !canAccessPanel("inventory") || !["owner", "editor"].includes(role); });
    document.querySelector("#projectWorkspaceForm").hidden = !canAccessPanel("project-workspaces") || !["owner", "editor"].includes(role);
    document.querySelectorAll("[data-workspace-card]").forEach((card) => { card.hidden = !workspaces[card.dataset.workspaceCard].panels.some((panel) => canAccessPanel(panel)); });
    const requestedWorkspace = new URLSearchParams(window.location.search).get("workspace");
    state.workspace = workspaces[requestedWorkspace] ? requestedWorkspace : "home";
    const workspace = workspaces[state.workspace];
    document.querySelector("#workspaceName").textContent = workspace ? `${workspace.code} WORKSPACE` : "WORKSPACE HUB";
    document.querySelector("#workspaceContext").textContent = workspace ? workspace.name : "SELECT WORKSPACE";
    document.title = workspace ? `${workspace.name} | TSL Control` : "后台工作区 | TSL Control";
    document.querySelectorAll(".admin-nav button[data-panel]").forEach((button) => {
      button.hidden = !workspace || button.dataset.workspace !== state.workspace || !canAccessPanel(button.dataset.panel);
      button.classList.remove("is-active");
    });
    document.querySelectorAll(".admin-panel").forEach((panel) => {
      panel.classList.remove("is-active");
      if (panel.dataset.panelView !== "workspace") panel.hidden = !canAccessPanel(panel.dataset.panelView);
    });
    if (!workspace) {
      document.querySelector('[data-panel-view="workspace"]').classList.add("is-active");
      return;
    }
    const requestedPanel = window.location.hash.slice(1);
    const target = document.querySelector(`.admin-nav button[data-workspace="${state.workspace}"][data-panel="${CSS.escape(requestedPanel)}"]:not([hidden])`) || document.querySelector(`.admin-nav button[data-workspace="${state.workspace}"]:not([hidden])`);
    if (!target) {
      state.workspace = "home";
      document.querySelector("#workspaceName").textContent = "WORKSPACE HUB";
      document.querySelector("#workspaceContext").textContent = "SELECT WORKSPACE";
      document.querySelector('[data-panel-view="workspace"]').classList.add("is-active");
      window.history.replaceState(null, "", "/admin.html");
      return;
    }
    target.click();
  }

  async function checkRemoteUpdates() {
    if (adminView.hidden) return;
    try {
      const sync = await api("/api/admin/sync");
      if (JSON.stringify(sync.user?.panelPermissions || []) !== JSON.stringify(state.user.panelPermissions || []) || JSON.stringify(sync.user?.departmentIds || []) !== JSON.stringify(state.user.departmentIds || []) || sync.user?.role !== state.user.role) {
        state.user = sync.user;
        await loadDashboard();
        return;
      }
      if (sync.content && Number(sync.content.revision || 0) > Number(state.content._meta?.revision || 0)) {
        const button = document.querySelector("#syncButton");
        button.hidden = false;
        button.classList.add("sync-alert");
        setStatus(`REMOTE REVISION ${sync.content.revision}`, true);
      }
      const localNew = state.applications.filter((item) => item.status === "new").length;
      const localApplicationUpdate = state.applications.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "");
      const applicationsChanged = sync.applications && ((canAccessPanel("applications") && (sync.applications.total !== state.applications.length || sync.applications.new !== localNew || (sync.applications.updatedAt || "") !== localApplicationUpdate)) || (canAccessPanel("notifications") && (sync.applications.updatedAt || null) !== state.notificationAudience.applicationsUpdatedAt));
      if (applicationsChanged) {
        if (canAccessPanel("applications")) { state.applications = await api("/api/admin/applications"); renderApplications(); }
        if (canAccessPanel("notifications")) { state.notificationAudience = await api("/api/admin/notification-audience"); renderNotifications(); }
      }
      const localMemberUpdate = state.members.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "");
      const membersChanged = sync.members && ((canAccessPanel("members") && (sync.members.total !== state.members.length || (sync.members.updatedAt || "") !== localMemberUpdate)) || (canAccessPanel("notifications") && (sync.members.updatedAt || null) !== state.notificationAudience.membersUpdatedAt));
      if (membersChanged) {
        if (canAccessPanel("members")) { state.members = await api("/api/admin/members"); renderMembers(); }
        if (canAccessPanel("notifications")) { state.notificationAudience = await api("/api/admin/notification-audience"); renderNotifications(); }
      }
      if (sync.notifications && (sync.notifications.latestId || "") !== (state.notifications[0]?.id || "")) {
        state.notifications = await api("/api/admin/notifications?limit=100");
        renderNotificationHistory();
      }
      const localMessageUpdate = state.memberMessages.reduce((latest, thread) => (thread.updatedAt || thread.createdAt || "") > latest ? (thread.updatedAt || thread.createdAt || "") : latest, "");
      if (sync.memberMessages && (sync.memberMessages.total !== state.memberMessages.length || (sync.memberMessages.updatedAt || "") !== localMessageUpdate)) {
        state.memberMessages = await api("/api/admin/member-messages?limit=200");
        renderMemberMessageAdminList();
      }
      const localInventoryUpdate = state.inventory.items.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "");
      if (sync.inventory && (sync.inventory.updatedAt || "") !== localInventoryUpdate) { state.inventory = await api("/api/admin/inventory"); renderInventory(); }
      const localFundUpdate = state.funds.accounts.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "");
      if (sync.funds && (sync.funds.updatedAt || "") !== localFundUpdate) { state.funds = await api("/api/admin/funds"); renderFunds(); }
      const localUsageUpdate = state.usageRequests.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "");
      if (sync.usageRequests && (sync.usageRequests.total !== state.usageRequests.length || (sync.usageRequests.updatedAt || "") !== localUsageUpdate)) { state.usageRequests = await api("/api/admin/usage-requests"); renderUsageRequests(); }
      if (canAccessPanel("project-workspaces")) {
        const refreshForm = !state.projectWorkspaceFormDirty;
        const editingId = document.querySelector("#projectWorkspaceForm").elements.id.value;
        const applied = await loadProjectWorkspaces();
        if (!applied) return;
        renderProjectWorkspaces();
        if (refreshForm && !state.projectWorkspaceFormDirty) populateProjectWorkspaceForm(state.projectWorkspaces.find((workspace) => workspace.id === editingId) || null);
      }
      if (sync.audit?.latestId && sync.audit.latestId !== state.audit[0]?.id) {
        state.audit = await api("/api/admin/audit?limit=200");
        renderAudit();
      }
    } catch (error) {
      if (error.status === 401) window.location.reload();
    }
  }

  async function loadDashboard() {
    const isOwner = state.user?.role === "owner";
    state.content = await api("/api/admin/content");
    state.contentResourceDraftDirty = false;
    state.loadErrors = {};
    const [content, applications, mail, audit, managers, members, notificationAudience, resourceSecrets, notifications, memberMessages, uploads, inventory, funds, usageRequests, bugReports] = await Promise.all([
      Promise.resolve(state.content),
      optionalLoad("applications", canAccessPanel("applications"), () => api("/api/admin/applications"), []),
      optionalLoad("mail", canAccessPanel("mail"), () => api("/api/admin/mail"), null),
      optionalLoad("audit", canAccessPanel("audit"), () => api("/api/admin/audit?limit=200"), []),
      optionalLoad("managers", isOwner, () => api("/api/admin/managers"), []),
      optionalLoad("members", canAccessPanel("members"), () => api("/api/admin/members"), []),
      optionalLoad("notificationAudience", canAccessPanel("notifications"), () => api("/api/admin/notification-audience"), { members: [], applicants: [], membersUpdatedAt: null, applicationsUpdatedAt: null }),
      optionalLoad("resourceSecrets", canAccessPanel("resources") && ["owner", "editor"].includes(state.user.role), () => api("/api/admin/resource-secrets", { method: "POST", body: "{}" }), {}),
      optionalLoad("notifications", canAccessPanel("notifications"), () => api("/api/admin/notifications?limit=100"), []),
      optionalLoad("memberMessages", canAccessPanel("notifications"), () => api("/api/admin/member-messages?limit=200"), []),
      optionalLoad("uploads", canAccessPanel("uploads"), () => api("/api/admin/uploads?limit=200"), []),
      optionalLoad("inventory", canAccessPanel("inventory"), () => api("/api/admin/inventory"), { items: [], ledger: [] }),
      optionalLoad("funds", canAccessPanel("funds"), () => api("/api/admin/funds"), { accounts: [], ledger: [] }),
      optionalLoad("usageRequests", canAccessPanel("usage"), () => api("/api/admin/usage-requests"), []),
      optionalLoad("bugReports", canAccessPanel("notifications"), () => api("/api/admin/bug-reports"), []),
      optionalLoad("projectWorkspaces", canAccessPanel("project-workspaces"), loadProjectWorkspaces, false)
    ]);
    state.content = content;
    state.applications = applications;
    state.mail = mail;
    state.audit = audit;
    state.managers = managers;
    state.members = members;
    state.notificationAudience = notificationAudience;
    state.resourceSecrets = resourceSecrets;
    state.notifications = notifications;
    state.memberMessages = memberMessages;
    state.uploads = uploads;
    state.inventory = inventory;
    state.funds = funds;
    state.usageRequests = usageRequests;
    state.bugReports = bugReports;
    if (!canAccessPanel("project-workspaces")) applyProjectWorkspacePayload({ workspaces: [], members: [], inventory: { items: [] }, funds: { accounts: [] } });
    state.projectWorkspacesError = state.loadErrors.projectWorkspaces || "";
    renderAllEditors();
    if (canAccessPanel("applications")) renderApplications();
    if (canAccessPanel("mail")) renderMail();
    if (isOwner) { renderManagers(); renderManagerFormAccess(); }
    if (canAccessPanel("members")) renderMembers();
    if (canAccessPanel("notifications")) renderNotifications();
    if (canAccessPanel("uploads")) renderUploads();
    if (canAccessPanel("inventory")) renderInventory();
    if (canAccessPanel("funds")) renderFunds();
    if (canAccessPanel("usage")) renderUsageRequests();
    if (canAccessPanel("project-workspaces")) { if (!state.projectWorkspaceFormDirty) populateProjectWorkspaceForm(); renderProjectWorkspaces(); }
    if (canAccessPanel("audit")) renderAudit();
    if (canAccessPanel("notifications")) renderBugReports();
    applyRoleAccess();
    loginView.hidden = true;
    adminView.hidden = false;
    document.querySelector("#currentUser").textContent = `${state.user.displayName} / ${state.user.role.toUpperCase()}`;
    document.querySelector("#syncButton").hidden = true;
    if (!state.syncTimer) state.syncTimer = window.setInterval(checkRemoteUpdates, 12000);
    showDashboardLoadErrors();
  }

  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = document.querySelector("#loginMessage");
    message.textContent = "AUTHENTICATING...";
    try {
      const payload = await api("/api/admin/login", { method: "POST", body: JSON.stringify({ username: document.querySelector("#adminUsername").value, password: document.querySelector("#adminPassword").value }) });
      state.csrf = payload.csrf;
      state.user = payload.user;
      await loadDashboard();
    } catch (error) {
      message.textContent = error.message;
    }
  });

  document.querySelectorAll(".admin-nav button[data-panel]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".admin-nav button").forEach((item) => item.classList.toggle("is-active", item === button));
    document.querySelectorAll(".admin-panel").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panelView === button.dataset.panel));
    if (state.workspace !== "home") window.history.replaceState(null, "", `/admin.html?workspace=${state.workspace}#${button.dataset.panel}`);
  }));
  document.querySelectorAll(".save-button").forEach((button) => button.addEventListener("click", saveContent));
  document.querySelector("#resourceEditor").addEventListener("input", () => { state.contentResourceDraftDirty = true; });
  document.querySelector("#resourceEditor").addEventListener("change", () => { state.contentResourceDraftDirty = true; });
  document.querySelector("#resourceEditor").addEventListener("click", (event) => { if (event.target.closest("button")) state.contentResourceDraftDirty = true; });
  document.querySelector("#adminProjectSearch").addEventListener("input", filterProjectEditor);
  document.querySelector("#adminProjectCategory").addEventListener("change", filterProjectEditor);
  document.querySelector("#addProject").addEventListener("click", () => { state.content = collectContent(); if (state.content.projects.length >= 100) { setStatus("公开项目最多 100 个", true); return; } state.content.projects.push({ id: "", title: "新项目", category: "未分类", description: "", tags: [], color: "#b8ff3d", video: "", poster: "", links: [] }); document.querySelector("#adminProjectSearch").value = ""; document.querySelector("#adminProjectCategory").value = ""; renderProjects(); });
  document.querySelector("#addAchievement").addEventListener("click", () => { state.content = collectContent(); state.content.achievements ||= []; if (state.content.achievements.length >= 100) { setStatus("成果展示最多 100 项", true); return; } state.content.achievements.push({ id: "", title: "新成果", type: "项目成果", description: "", date: "", projectId: "", image: "", url: "" }); renderAchievements(); });
  document.querySelector("#addDepartment").addEventListener("click", () => { state.content = collectContent(); state.content.departments.push({ id: "", name: "新部门", description: "", isOpen: true }); renderDepartments(); });
  document.querySelector("#addResource").addEventListener("click", () => { state.content = collectContent(); state.content.resources.push({ id: "", title: "新资源", description: "", type: "WEBSITE", url: "", links: [], accessNote: "", permissionKey: "", accessSecret: "", children: [] }); state.contentResourceDraftDirty = true; renderResources(); });
  document.querySelector("#refreshApplications").addEventListener("click", (event) => refreshPanel(event.currentTarget, async () => { state.applications = await api("/api/admin/applications"); }, renderApplications, "APPLICATIONS REFRESHED"));
  document.querySelector("#refreshUsageRequests").addEventListener("click", (event) => refreshPanel(event.currentTarget, async () => { state.usageRequests = await api("/api/admin/usage-requests"); }, renderUsageRequests, "USAGE REQUESTS REFRESHED"));
  document.querySelector("#refreshAudit").addEventListener("click", (event) => refreshPanel(event.currentTarget, async () => { state.audit = await api("/api/admin/audit?limit=200"); }, renderAudit, "AUDIT LOG REFRESHED"));
  document.querySelector("#refreshProjectWorkspaces").addEventListener("click", async (event) => {
    const form = document.querySelector("#projectWorkspaceForm");
    const refreshForm = !state.projectWorkspaceFormDirty;
    const editingId = form.elements.id.value;
    if (!refreshForm && !window.confirm("刷新只更新工作区列表，当前未保存表单将保留。继续？")) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const applied = await loadProjectWorkspaces();
      if (!applied) return;
      renderProjectWorkspaces();
      if (refreshForm && !state.projectWorkspaceFormDirty) populateProjectWorkspaceForm(state.projectWorkspaces.find((workspace) => workspace.id === editingId) || null);
      setStatus("PROJECT WORKSPACES REFRESHED");
    } catch (error) {
      state.projectWorkspacesError = error.message;
      renderProjectWorkspaces();
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#syncButton").addEventListener("click", async (event) => {
    if (!window.confirm("同步会重新读取服务器内容，尚未保存的本地修改会丢失。继续？")) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await loadDashboard();
      if (!Object.keys(state.loadErrors).length) setStatus("SYNC COMPLETE");
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#logoutButton").addEventListener("click", async () => { await api("/api/admin/logout", { method: "POST", body: "{}" }); window.location.assign("/portal.html?type=admin"); });

  document.querySelector("#managerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = document.querySelector("#managerMessage");
    const formData = new FormData(form);
    const values = Object.fromEntries(formData.entries());
    values.panelPermissions = formData.getAll("panelPermissions");
    values.departmentIds = formData.getAll("departmentIds");
    message.textContent = "CREATING MANAGER...";
    try {
      const payload = await api("/api/admin/managers", { method: "POST", body: JSON.stringify(values) });
      state.managers.push(payload.manager);
      renderManagers();
      form.reset();
      renderManagerFormAccess();
      message.textContent = "MANAGER CREATED";
    } catch (error) { message.textContent = error.message; }
  });

  document.querySelector("#memberForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = document.querySelector("#memberMessage");
    const values = Object.fromEntries(new FormData(form).entries());
    values.permissions = String(values.permissions || "").split(",").map((item) => item.trim()).filter(Boolean);
    message.textContent = "CREATING MEMBER...";
    try {
      const payload = await api("/api/admin/members", { method: "POST", body: JSON.stringify(values) });
      state.members.push(payload.member);
      syncWorkspaceMemberOption(payload.member);
      renderMembers();
      if (state.user.role === "owner") renderManagerFormAccess();
      form.reset();
      message.textContent = `MEMBER CREATED / ${payload.member.username} / 激活码 ${payload.activationCode}${payload.activationNotified ? " / 已发送邮箱" : " / 请转交成员"}`;
    } catch (error) { message.textContent = error.message; }
  });

  document.querySelector("#inventoryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = document.querySelector("#inventoryMessage");
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    message.textContent = "CREATING MATERIAL...";
    try {
      const formData = new FormData(form);
      const componentFile = formData.get("componentImageFile");
      const locationFile = formData.get("locationImageFile");
      const values = Object.fromEntries(formData.entries());
      delete values.componentImageFile;
      delete values.locationImageFile;
      if (componentFile?.size || locationFile?.size) message.textContent = "UPLOADING MATERIAL IMAGES...";
      const [componentUpload, locationUpload] = await Promise.all([
        componentFile?.size ? uploadInventoryImage(componentFile) : null,
        locationFile?.size ? uploadInventoryImage(locationFile) : null
      ]);
      values.componentImage = componentUpload?.url || "";
      values.locationImage = locationUpload?.url || "";
      const payload = await api("/api/admin/inventory", { method: "POST", body: JSON.stringify(values) });
      state.inventory.items.push(payload.item);
      state.inventory = await api("/api/admin/inventory");
      renderInventory();
      form.reset();
      message.textContent = "MATERIAL CREATED";
    }
    catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.querySelector("#inventorySearch").addEventListener("input", renderInventory);
  document.querySelector("#inventoryCategory").addEventListener("change", renderInventory);
  document.querySelector("#inventoryImportFile").addEventListener("change", () => {
    inventoryImportGeneration += 1;
    inventoryImportReady = false;
    document.querySelector("#commitInventoryImport").disabled = true;
    document.querySelector("#inventoryImportPreview").replaceChildren();
    document.querySelector("#inventoryImportMessage").textContent = "请先解析并预览表格";
  });
  document.querySelector("#previewInventoryImport").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try { await parseInventoryImport(false); }
    catch (error) {
      inventoryImportReady = false;
      document.querySelector("#commitInventoryImport").disabled = true;
      document.querySelector("#inventoryImportMessage").textContent = error.message;
    } finally { event.currentTarget.disabled = false; }
  });
  document.querySelector("#inventoryImportForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!inventoryImportReady) return;
    const button = document.querySelector("#commitInventoryImport");
    const fileInput = document.querySelector("#inventoryImportFile");
    button.disabled = true;
    fileInput.disabled = true;
    try {
      const payload = await parseInventoryImport(true);
      state.inventory = await api("/api/admin/inventory");
      renderInventory();
      inventoryImportReady = false;
      event.currentTarget.reset();
      document.querySelector("#inventoryImportPreview").replaceChildren();
      document.querySelector("#inventoryImportMessage").textContent = `导入完成：${payload.count} 项物资已写入库存`;
      setStatus(`INVENTORY IMPORTED / ${payload.count} ITEMS`);
    } catch (error) {
      document.querySelector("#inventoryImportMessage").textContent = error.message;
      button.disabled = !inventoryImportReady;
    } finally { fileInput.disabled = false; }
  });
  document.querySelector("#downloadInventoryTemplate").addEventListener("click", () => {
    const csv = "\uFEFF材料名称,SKU,分类,单位,初始数量,单位成本,收纳容器,位置标签,行,列,备注\n温湿度传感器,SENSOR-001,传感器,个,10,12.5,收纳盒,传感器,1,1,示例数据\n核心板,BOARD-001,核心板,块,5,88,收纳盒,核心板,2,1,\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "物资导入模板.csv";
    link.click();
    URL.revokeObjectURL(url);
  });

  document.querySelector("#fundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = document.querySelector("#fundMessage");
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    message.textContent = "CREATING FUND ACCOUNT...";
    try { const payload = await api("/api/admin/funds", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) }); state.funds.accounts.push(payload.account); state.funds = await api("/api/admin/funds"); renderFunds(); form.reset(); message.textContent = "FUND ACCOUNT CREATED"; }
    catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  });

  document.querySelector("#projectWorkspaceMembers").addEventListener("change", syncProjectLeaderChoices);
  document.querySelector("#projectWorkspaceForm").addEventListener("input", () => { state.projectWorkspaceFormDirty = true; });
  document.querySelector("#projectWorkspaceForm").addEventListener("change", () => { state.projectWorkspaceFormDirty = true; });
  document.querySelector("#addProjectAllocation").addEventListener("click", () => {
    addProjectAllocationRow();
    state.projectWorkspaceFormDirty = true;
  });
  document.querySelector("#cancelProjectWorkspaceEdit").addEventListener("click", resetProjectWorkspaceForm);
  document.querySelector("#projectWorkspaceForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const message = document.querySelector("#projectWorkspaceMessage");
    const id = form.elements.id.value;
    const memberIds = [...form.elements.memberIds.selectedOptions].map((option) => option.value);
    const managerIds = [...form.elements.managerIds.selectedOptions].map((option) => option.value);
    if (!memberIds.length || !managerIds.length || managerIds.some((managerId) => !memberIds.includes(managerId))) {
      message.textContent = "请至少选择一名成员和负责人，且负责人必须属于项目成员。";
      return;
    }
    const allocations = [...document.querySelectorAll("#projectAllocationRows .project-allocation-row")].map((row) => ({
      id: row.dataset.allocationId || undefined,
      type: row.querySelector('[data-allocation-field="type"]').value,
      targetId: row.querySelector('[data-allocation-field="targetId"]').value,
      allocated: Number(row.querySelector('[data-allocation-field="allocated"]').value),
      note: row.querySelector('[data-allocation-field="note"]').value
    })).filter((allocation) => allocation.targetId);
    const payload = {
      name: form.elements.name.value,
      projectId: form.elements.projectId.value || null,
      description: form.elements.description.value,
      status: form.elements.status.value,
      revision: Number(form.elements.revision.value) || 0,
      memberIds,
      managerIds,
      allocations
    };
    button.disabled = true;
    message.textContent = id ? "SAVING PROJECT WORKSPACE..." : "CREATING PROJECT WORKSPACE...";
    try {
      const result = await api(id ? `/api/admin/project-workspaces/${encodeURIComponent(id)}` : "/api/admin/project-workspaces", { method: id ? "PATCH" : "POST", body: JSON.stringify(payload) });
      const workspace = result.projectWorkspace || result.workspace || result.item;
      if (workspace) {
        const index = state.projectWorkspaces.findIndex((item) => item.id === workspace.id);
        if (index >= 0) state.projectWorkspaces[index] = workspace;
        else state.projectWorkspaces.unshift(workspace);
      } else {
        await loadProjectWorkspaces();
      }
      state.projectWorkspacesError = "";
      delete state.loadErrors.projectWorkspaces;
      renderProjectWorkspaces();
      resetProjectWorkspaceForm();
      const mailStatus = leadNotificationStatus(result.leadNotification, Boolean(id));
      message.textContent = `${id ? "PROJECT WORKSPACE SAVED" : "PROJECT WORKSPACE CREATED"}${mailStatus.text}`;
      setStatus(message.textContent, mailStatus.warning);
    } catch (error) {
      message.textContent = error.status === 409 ? `REVISION ${form.elements.revision.value} CONFLICT / ${error.message}。请刷新列表并重新点击编辑后重试。` : error.message;
      if (error.status === 409) setStatus("PROJECT WORKSPACE REVISION CONFLICT / 请刷新", true);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#notificationForm").addEventListener("change", updateNotificationSummary);
  document.querySelector("#notificationForm").addEventListener("input", updateNotificationSummary);
  document.querySelector("#notificationForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = document.querySelector("#notificationMessage");
    const button = form.querySelector('button[type="submit"]');
    const audience = {
      allMembers: form.elements.allMembers.checked,
      allApplicants: form.elements.allApplicants.checked,
      includeManagers: form.elements.includeManagers.checked,
      includeDefaultRecipients: form.elements.includeDefaultRecipients.checked,
      departmentIds: [...form.querySelectorAll('[name="departmentIds"]:checked')].map((input) => input.value),
      memberIds: [...form.querySelectorAll('[name="memberIds"]:checked')].map((input) => input.value),
      applicationIds: [...form.querySelectorAll('[name="applicationIds"]:checked')].map((input) => input.value),
      permissionKeys: form.elements.permissionKeys.value.split(",").map((item) => item.trim()).filter(Boolean),
      customEmails: form.elements.customEmails.value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean)
    };
    button.disabled = true;
    message.textContent = "DISPATCHING NOTIFICATION...";
    try {
      const payload = await api("/api/admin/notifications", { method: "POST", body: JSON.stringify({ subject: form.elements.subject.value, message: form.elements.message.value, audience }) });
      state.notifications.unshift(payload.notification);
      renderNotificationHistory();
      form.reset();
      updateNotificationSummary();
      message.textContent = `SENT / ${payload.notification.recipientCount} RECIPIENTS`;
    } catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  });

  document.querySelector("#uploadButton").addEventListener("click", async (event) => {
    const files = [...document.querySelector("#mediaFiles").files];
    const message = document.querySelector("#uploadMessage");
    const queue = document.querySelector("#uploadQueue");
    if (!files.length) { message.textContent = "请选择至少一个文件"; return; }
    if (files.length > 20) { message.textContent = "单次最多选择 20 个文件"; return; }
    const button = event.currentTarget;
    button.disabled = true;
    queue.replaceChildren();
    message.textContent = `正在检查 ${files.length} 个文件...`;
    try {
      const inspected = await Promise.all(files.map(inspectProjectMedia));
      inspected.forEach((result) => queue.appendChild(renderUploadQueueItem(result, result.errors.length ? "error" : "ready", result.errors.length ? result.errors.join("；") : "")));
      const invalid = inspected.filter((result) => result.errors.length);
      if (invalid.length) {
        message.textContent = `检查未通过：请先修正 ${invalid.length} 个文件，本次尚未上传任何内容。`;
        return;
      }
      let completed = 0;
      for (const [index, result] of inspected.entries()) {
        queue.replaceChild(renderUploadQueueItem(result, "uploading", `${formatFileSize(result.file.size)} / ${index + 1} of ${inspected.length}`), queue.children[index]);
        const body = new FormData();
        body.append("file", result.file);
        try {
          const payload = await api("/api/admin/upload", { method: "POST", body });
          document.querySelector("#uploadUrl").value = payload.url;
          if (payload.file) state.uploads.unshift(payload.file);
          completed += 1;
          queue.replaceChild(renderUploadQueueItem(result, "complete", payload.url), queue.children[index]);
        } catch (error) {
          queue.replaceChild(renderUploadQueueItem(result, "error", error.message), queue.children[index]);
        }
      }
      renderUploads();
      document.querySelector("#mediaFiles").value = "";
      message.textContent = `批量上传完成：成功 ${completed} 个，失败 ${inspected.length - completed} 个。`;
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#copyUploadUrl").addEventListener("click", async () => {
    const value = document.querySelector("#uploadUrl").value;
    if (!value) { document.querySelector("#uploadMessage").textContent = "暂无可复制的上传地址"; return; }
    try {
      await navigator.clipboard.writeText(value);
      document.querySelector("#uploadMessage").textContent = "已复制最近一次上传地址";
    } catch {
      document.querySelector("#uploadMessage").textContent = "浏览器未允许复制，请手动选择地址";
    }
  });
  document.querySelector("#refreshUploads").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      state.uploads = await api("/api/admin/uploads?limit=200");
      renderUploads();
      setStatus("UPLOAD LIBRARY REFRESHED");
    } catch (error) { setStatus(error.message, true); }
    finally { button.disabled = false; }
  });

  document.querySelector("#saveMailButton").addEventListener("click", async () => {
    const message = document.querySelector("#mailMessage");
    const button = document.querySelector("#saveMailButton");
    button.disabled = true;
    message.textContent = "VERIFYING SMTP CHANNEL...";
    try {
      state.mail = await api("/api/admin/mail", {
        method: "PUT",
        body: JSON.stringify({
          email: document.querySelector("#mailEmail").value,
          authCode: document.querySelector("#mailAuthCode").value,
          senderName: document.querySelector("#mailSenderName").value,
          replyTo: document.querySelector("#mailReplyTo").value,
          recipients: document.querySelector("#mailRecipients").value.split(/[\n,;]+/).map((email) => email.trim()).filter(Boolean),
          applicationRecipientAdminIds: [...document.querySelectorAll("#applicationRecipientManagers input:checked")].map((input) => input.value),
          usageApprovedSubject: document.querySelector("#usageApprovedSubject").value,
          usageApprovedBody: document.querySelector("#usageApprovedBody").value,
          usageRejectedSubject: document.querySelector("#usageRejectedSubject").value,
          usageRejectedBody: document.querySelector("#usageRejectedBody").value,
          applicationAcceptedSubject: document.querySelector("#applicationAcceptedSubject").value,
          applicationAcceptedBody: document.querySelector("#applicationAcceptedBody").value,
          applicationRejectedSubject: document.querySelector("#applicationRejectedSubject").value,
          applicationRejectedBody: document.querySelector("#applicationRejectedBody").value
        })
      });
      document.querySelector("#mailAuthCode").value = "";
      renderMail();
      message.textContent = "CHANNEL VERIFIED / ENCRYPTED CONFIG SAVED";
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#testMailButton").addEventListener("click", async () => {
    const message = document.querySelector("#mailMessage");
    const button = document.querySelector("#testMailButton");
    button.disabled = true;
    message.textContent = "SENDING TEST MESSAGE...";
    try {
      await api("/api/admin/mail/test", { method: "POST", body: "{}" });
      message.textContent = "TEST MESSAGE SENT / 请检查 QQ 邮箱";
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector('#managerForm select[name="role"]').addEventListener("change", renderManagerFormAccess);

  api("/api/admin/session").then(async (payload) => { state.csrf = payload.csrf; state.user = payload.user; await loadDashboard(); }).catch(() => {});
})();
