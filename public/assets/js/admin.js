(function () {
  "use strict";

  const state = { csrf: "", user: null, content: null, applications: [], mail: null, managers: [], members: [], resourceSecrets: {}, notifications: [], inventory: { items: [], ledger: [] }, funds: { accounts: [], ledger: [] }, usageRequests: [], audit: [], syncTimer: 0 };
  const loginView = document.querySelector("#loginView");
  const adminView = document.querySelector("#adminView");
  const saveStatus = document.querySelector("#saveStatus");

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

  function field(labelText, value, key, options = {}) {
    const label = document.createElement("label");
    label.className = `field${options.wide ? " field--wide" : ""}`;
    label.append(document.createTextNode(labelText));
    const input = options.multiline ? document.createElement("textarea") : document.createElement("input");
    input.value = value || "";
    input.dataset.field = key;
    if (options.type) input.type = options.type;
    if (options.placeholder) input.placeholder = options.placeholder;
    label.appendChild(input);
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
        field("系统编号", project.id, "id"), field("项目名称", project.title, "title"),
        field("项目分类", project.category || "未分类", "category"),
        field("主题色", project.color, "color", { type: "color" }), field("标签（英文逗号分隔）", project.tags.join(", "), "tags"),
        field("项目简介", project.description, "description", { wide: true, multiline: true }),
        field("视频地址", project.video, "video", { placeholder: "/uploads/demo.mp4" }),
        field("海报地址", project.poster, "poster", { placeholder: "/uploads/poster.webp" })
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
      grid.append(field("部门 ID", department.id, "id"), field("部门名称", department.name, "name"), field("部门介绍", department.description, "description", { wide: true, multiline: true }));
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
    state.content.resources.forEach((resource, index) => {
      const article = card(`${String(index + 1).padStart(2, "0")} / ${resource.title || "未命名资源"}`, index, () => {
        state.content = collectContent();
        state.content.resources.splice(index, 1);
        renderResources();
      });
      const grid = document.createElement("div");
      grid.className = "editor-grid";
      grid.append(
        field("资源 ID", resource.id, "id"), field("资源名称", resource.title, "title"),
        field("资源类型", resource.type, "type"), field("目标地址", resource.url, "url"),
        field("资源介绍", resource.description, "description", { wide: true, multiline: true }),
        field("公开访问说明", resource.accessNote, "accessNote", { wide: true }),
        field("权限标识（留空表示公开）", resource.permissionKey || "", "permissionKey", { placeholder: "resource.basic" }),
        field("受保护密码 / 提取码", state.resourceSecrets[resource.id] || "", "accessSecret", { placeholder: "仅授权成员可读取" })
      );
      article.appendChild(grid);
      editor.appendChild(article);
    });
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
        url: row.querySelector('[data-link-field="url"]').value
      }));
      return { ...values, tags: values.tags.split(",").map((tag) => tag.trim()).filter(Boolean), links };
    });
    const departments = [...document.querySelectorAll("#departmentEditor .editor-card")].map(collectFields);
    const resources = [...document.querySelectorAll("#resourceEditor .editor-card")].map(collectFields);
    return { settings, projects, departments, resources, _meta: state.content._meta || { revision: 0 } };
  }

  async function saveContent() {
    try {
      setStatus("SAVING...");
      const payload = await api("/api/admin/content", { method: "PUT", body: JSON.stringify(collectContent()) });
      state.content = payload.content;
      state.resourceSecrets = await api("/api/admin/resource-secrets");
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
        try {
          await api(`/api/admin/applications/${encodeURIComponent(application.id)}`, { method: "PATCH", body: JSON.stringify({ status: status.value }) });
          application.status = status.value;
          renderApplications();
        } catch (error) {
          setStatus(error.message, true);
        }
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "删除申请";
      remove.addEventListener("click", async () => {
        if (!window.confirm(`确认删除 ${application.name} 的申请？`)) return;
        try {
          await api(`/api/admin/applications/${encodeURIComponent(application.id)}`, { method: "DELETE", body: "{}" });
          state.applications = state.applications.filter((item) => item.id !== application.id);
          renderApplications();
        } catch (error) {
          setStatus(error.message, true);
        }
      });
      controls.appendChild(status);
      if (state.user?.role === "owner") {
        if (!application.memberId) {
          const promote = document.createElement("button");
          promote.type = "button";
          promote.className = "small-button";
          promote.textContent = "转为成员";
          promote.addEventListener("click", async () => {
            const suggested = (application.email?.split("@")[0] || application.studentId || application.name).toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40);
            const username = window.prompt("成员登录账号", suggested);
            if (!username) return;
            const password = window.prompt("初始密码（至少 8 位）");
            if (!password) return;
            const permissionText = window.prompt("初始资源权限（逗号分隔，可留空）", "resource.basic") || "";
            try {
              const payload = await api(`/api/admin/applications/${encodeURIComponent(application.id)}/promote`, { method: "POST", body: JSON.stringify({ username, password, permissions: permissionText.split(",").map((item) => item.trim()).filter(Boolean) }) });
              Object.assign(application, payload.application);
              state.members.push(payload.member);
              renderApplications();
              renderMembers();
              setStatus("MEMBER ACCOUNT CREATED");
            } catch (error) { setStatus(error.message, true); }
          });
          controls.appendChild(promote);
        }
        controls.appendChild(remove);
      }
      article.append(identity, contact, motivation, controls);
      list.appendChild(article);
    });
  }

  function renderAllEditors() {
    renderSettings();
    renderProjects();
    renderDepartments();
    renderResources();
  }

  function renderMail() {
    const configured = Boolean(state.mail?.configured);
    const status = document.querySelector("#mailState");
    status.textContent = configured ? "ONLINE / VERIFIED" : "NOT CONFIGURED";
    status.classList.toggle("is-online", configured);
    document.querySelector("#mailEmail").value = state.mail?.email || state.content.settings.managerEmail || "2152202573@qq.com";
    document.querySelector("#mailSenderName").value = state.mail?.senderName || `${state.content.settings.clubName}运营组`;
    document.querySelector("#mailReplyTo").value = state.mail?.replyTo || state.mail?.email || state.content.settings.managerEmail || "";
    document.querySelector("#mailRecipients").value = (state.mail?.recipients || [state.content.settings.managerEmail].filter(Boolean)).join("\n");
    document.querySelector("#mailAuthCode").placeholder = configured ? "已加密保存，留空可保留当前授权码" : "在 QQ 邮箱设置中生成，不是 QQ 密码";
    document.querySelector("#testMailButton").disabled = !configured;
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
      const email = document.createElement("p");
      email.textContent = manager.email || "未设置邮箱";
      const role = document.createElement("select");
      [["owner", "主管理员"], ["editor", "内容编辑"], ["reviewer", "申请审核"]].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = manager.role === value;
        role.appendChild(option);
      });
      const actions = document.createElement("div");
      actions.className = "manager-card__actions";
      const save = document.createElement("button");
      save.type = "button";
      save.className = "small-button";
      save.textContent = "保存角色";
      save.addEventListener("click", async () => {
        try {
          const payload = await api(`/api/admin/managers/${encodeURIComponent(manager.id)}`, { method: "PATCH", body: JSON.stringify({ role: role.value }) });
          Object.assign(manager, payload.manager);
          setStatus("MANAGER UPDATED");
        } catch (error) { setStatus(error.message, true); role.value = manager.role; }
      });
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
      actions.append(save, password);
      if (manager.id !== state.user.id) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "danger-button";
        remove.textContent = "删除";
        remove.addEventListener("click", async () => {
          if (!window.confirm(`确认删除管理员 ${manager.username}？`)) return;
          try {
            await api(`/api/admin/managers/${encodeURIComponent(manager.id)}`, { method: "DELETE", body: "{}" });
            state.managers = state.managers.filter((item) => item.id !== manager.id);
            renderManagers();
          } catch (error) { setStatus(error.message, true); }
        });
        actions.appendChild(remove);
      }
      article.append(identity, email, role, actions);
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
      contact.textContent = `${department?.name || member.departmentId || "未分配部门"}\n学号：${member.studentId || "未填写"}\n班级：${member.className || "未填写"}\n${member.email || member.contact || "未填写联系方式"}`;
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
      if (state.user.role === "owner") {
        const save = document.createElement("button");
        save.type = "button";
        save.className = "small-button";
        save.textContent = "保存权限";
        save.addEventListener("click", async () => {
          try {
            const payload = await api(`/api/admin/members/${encodeURIComponent(member.id)}`, { method: "PATCH", body: JSON.stringify({ status: status.value, permissions: permissions.value.split(",").map((item) => item.trim()).filter(Boolean) }) });
            Object.assign(member, payload.member);
            setStatus("MEMBER ACCESS UPDATED");
          } catch (error) { setStatus(error.message, true); }
        });
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "small-button";
        reset.textContent = "重置密码";
        reset.addEventListener("click", async () => {
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
          try { await api(`/api/admin/members/${encodeURIComponent(member.id)}`, { method: "DELETE", body: "{}" }); state.members = state.members.filter((item) => item.id !== member.id); renderMembers(); }
          catch (error) { setStatus(error.message, true); }
        });
        actions.append(save, reset, remove);
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
    state.members.filter((member) => member.status === "active" && member.email).forEach((member) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "memberIds";
      input.value = member.id;
      label.append(input, document.createTextNode(` ${member.name} / ${member.email}`));
      members.appendChild(label);
    });
    if (!members.children.length) members.textContent = "暂无具有邮箱的有效成员";
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

  function updateNotificationSummary() {
    const form = document.querySelector("#notificationForm");
    const allMembers = form.elements.allMembers.checked;
    const selectedMembers = form.querySelectorAll('[name="memberIds"]:checked').length;
    const selectedDepartments = form.querySelectorAll('[name="departmentIds"]:checked').length;
    const permissionKeys = form.elements.permissionKeys.value.split(",").map((item) => item.trim()).filter(Boolean).length;
    const customEmails = form.elements.customEmails.value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean).length;
    document.querySelector("#notificationSummary").textContent = `AUDIENCE / ${allMembers ? `ALL MEMBERS ${state.members.filter((member) => member.status === "active" && member.email).length}` : `MEMBERS ${selectedMembers}`} / DEPARTMENTS ${selectedDepartments} / PERMISSIONS ${permissionKeys} / CUSTOM ${customEmails}${form.elements.includeManagers.checked ? " / MANAGERS" : ""}${form.elements.includeDefaultRecipients.checked ? " / DEFAULT GROUP" : ""}`;
  }

  function renderInventory() {
    const list = document.querySelector("#inventoryList");
    list.replaceChildren();
    state.inventory.items.forEach((item) => {
      const article = document.createElement("article");
      article.className = "inventory-card";
      const code = document.createElement("span");
      code.textContent = `[ ${item.sku || item.id} / ${item.category || "UNCATEGORIZED"} ]`;
      const title = document.createElement("h3");
      title.textContent = item.name;
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
        const restock = document.createElement("button");
        restock.type = "button";
        restock.className = "small-button";
        restock.textContent = "入库";
        restock.addEventListener("click", async () => {
          const quantity = window.prompt(`输入 ${item.name} 的入库数量`);
          if (!quantity) return;
          const reason = window.prompt("入库原因 / 来源");
          if (!reason) return;
          try { const payload = await api(`/api/admin/inventory/${item.id}/restock`, { method: "POST", body: JSON.stringify({ quantity, reason }) }); Object.assign(item, payload.item); state.inventory = await api("/api/admin/inventory"); renderInventory(); }
          catch (error) { setStatus(error.message, true); }
        });
        actions.appendChild(restock);
      }
      article.append(code, title, meta, value, actions);
      list.appendChild(article);
    });
    if (!state.inventory.items.length) list.textContent = "NO MATERIALS / 暂无物资";
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
        const topup = document.createElement("button");
        topup.type = "button";
        topup.className = "small-button";
        topup.textContent = "入账";
        topup.addEventListener("click", async () => {
          const amount = window.prompt(`输入 ${account.name} 的入账金额`);
          if (!amount) return;
          const reason = window.prompt("入账来源 / 原因");
          if (!reason) return;
          try { const payload = await api(`/api/admin/funds/${account.id}/topup`, { method: "POST", body: JSON.stringify({ amount, reason }) }); Object.assign(account, payload.account); state.funds = await api("/api/admin/funds"); renderFunds(); }
          catch (error) { setStatus(error.message, true); }
        });
        actions.appendChild(topup);
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
      target.textContent = `${usageRequest.type === "material" ? "材料" : "资金"}\n${usageRequest.targetName}\n${usageRequest.type === "material" ? `${usageRequest.quantity} ${usageRequest.unit}` : `${Number(usageRequest.amount).toFixed(2)} ${usageRequest.currency}`}`;
      const purpose = document.createElement("p");
      purpose.textContent = `${usageRequest.purpose}\n\n状态：${usageRequest.status}${usageRequest.reviewNote ? `\n意见：${usageRequest.reviewNote}` : ""}`;
      purpose.classList.add(`status-${usageRequest.status}`);
      const actions = document.createElement("div");
      actions.className = "usage-card__actions";
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
          try { const payload = await api(`/api/admin/usage-requests/${usageRequest.id}`, { method: "PATCH", body: JSON.stringify({ decision, reviewNote: note.value }) }); Object.assign(usageRequest, payload.request); state.inventory = await api("/api/admin/inventory"); state.funds = await api("/api/admin/funds"); renderUsageRequests(); renderInventory(); renderFunds(); }
          catch (error) { setStatus(error.message, true); }
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
    document.querySelectorAll("[data-owner-only]").forEach((element) => { element.hidden = role !== "owner"; });
    document.querySelectorAll("[data-inventory-edit]").forEach((element) => { element.hidden = !["owner", "editor"].includes(role); });
    const allowed = role === "reviewer" ? new Set(["applications", "members", "audit", "inventory", "funds", "usage"]) : role === "editor" ? new Set(["settings", "projects", "departments", "resources", "applications", "notifications", "uploads", "members", "audit", "inventory", "funds", "usage"]) : null;
    if (allowed) {
      document.querySelectorAll(".admin-nav button[data-panel]").forEach((button) => { if (!allowed.has(button.dataset.panel)) button.hidden = true; });
      const activeButton = document.querySelector(".admin-nav button.is-active:not([hidden])") || document.querySelector(`.admin-nav button[data-panel="${role === "reviewer" ? "applications" : "settings"}"]`);
      activeButton?.click();
    }
  }

  async function checkRemoteUpdates() {
    if (adminView.hidden) return;
    try {
      const sync = await api("/api/admin/sync");
      if (Number(sync.content.revision || 0) > Number(state.content._meta?.revision || 0)) {
        const button = document.querySelector("#syncButton");
        button.hidden = false;
        button.classList.add("sync-alert");
        setStatus(`REMOTE REVISION ${sync.content.revision}`, true);
      }
      const localNew = state.applications.filter((item) => item.status === "new").length;
      const localApplicationUpdate = state.applications.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "");
      if (sync.applications.total !== state.applications.length || sync.applications.new !== localNew || (sync.applications.updatedAt || "") !== localApplicationUpdate) {
        state.applications = await api("/api/admin/applications");
        renderApplications();
      }
      const localMemberUpdate = state.members.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "");
      if (sync.members.total !== state.members.length || (sync.members.updatedAt || "") !== localMemberUpdate) {
        state.members = await api("/api/admin/members");
        renderMembers();
        renderNotifications();
      }
      if (sync.notifications && (sync.notifications.latestAt || "") !== (state.notifications[0]?.sentAt || "") && ["owner", "editor"].includes(state.user.role)) {
        state.notifications = await api("/api/admin/notifications?limit=100");
        renderNotificationHistory();
      }
      const localInventoryUpdate = state.inventory.items.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "");
      if ((sync.inventory?.updatedAt || "") !== localInventoryUpdate) { state.inventory = await api("/api/admin/inventory"); renderInventory(); }
      const localFundUpdate = state.funds.accounts.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "");
      if ((sync.funds?.updatedAt || "") !== localFundUpdate) { state.funds = await api("/api/admin/funds"); renderFunds(); }
      const localUsageUpdate = state.usageRequests.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "");
      if (sync.usageRequests && (sync.usageRequests.total !== state.usageRequests.length || (sync.usageRequests.updatedAt || "") !== localUsageUpdate)) { state.usageRequests = await api("/api/admin/usage-requests"); renderUsageRequests(); }
      if (sync.audit.latestId && sync.audit.latestId !== state.audit[0]?.id) {
        state.audit = await api("/api/admin/audit?limit=200");
        renderAudit();
      }
    } catch (error) {
      if (error.status === 401) window.location.reload();
    }
  }

  async function loadDashboard() {
    const isOwner = state.user?.role === "owner";
    const canEditContent = ["owner", "editor"].includes(state.user?.role);
    const [content, applications, mail, audit, managers, members, resourceSecrets, notifications, inventory, funds, usageRequests] = await Promise.all([
      api("/api/admin/content"),
      api("/api/admin/applications"),
      api("/api/admin/mail"),
      api("/api/admin/audit?limit=200"),
      isOwner ? api("/api/admin/managers") : Promise.resolve([]),
      api("/api/admin/members"),
      canEditContent ? api("/api/admin/resource-secrets") : Promise.resolve({}),
      canEditContent ? api("/api/admin/notifications?limit=100") : Promise.resolve([]),
      api("/api/admin/inventory"),
      api("/api/admin/funds"),
      api("/api/admin/usage-requests")
    ]);
    state.content = content;
    state.applications = applications;
    state.mail = mail;
    state.audit = audit;
    state.managers = managers;
    state.members = members;
    state.resourceSecrets = resourceSecrets;
    state.notifications = notifications;
    state.inventory = inventory;
    state.funds = funds;
    state.usageRequests = usageRequests;
    renderAllEditors();
    renderApplications();
    renderMail();
    renderManagers();
    renderMembers();
    renderNotifications();
    renderInventory();
    renderFunds();
    renderUsageRequests();
    renderAudit();
    applyRoleAccess();
    loginView.hidden = true;
    adminView.hidden = false;
    document.querySelector("#currentUser").textContent = `${state.user.displayName} / ${state.user.role.toUpperCase()}`;
    document.querySelector("#syncButton").hidden = true;
    if (!state.syncTimer) state.syncTimer = window.setInterval(checkRemoteUpdates, 12000);
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

  document.querySelectorAll(".admin-nav button").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".admin-nav button").forEach((item) => item.classList.toggle("is-active", item === button));
    document.querySelectorAll(".admin-panel").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panelView === button.dataset.panel));
  }));
  document.querySelectorAll(".save-button").forEach((button) => button.addEventListener("click", saveContent));
  document.querySelector("#adminProjectSearch").addEventListener("input", filterProjectEditor);
  document.querySelector("#adminProjectCategory").addEventListener("change", filterProjectEditor);
  document.querySelector("#addProject").addEventListener("click", () => { state.content = collectContent(); state.content.projects.push({ id: "", title: "新项目", category: "未分类", description: "", tags: [], color: "#b8ff3d", video: "", poster: "", links: [] }); document.querySelector("#adminProjectSearch").value = ""; document.querySelector("#adminProjectCategory").value = ""; renderProjects(); });
  document.querySelector("#addDepartment").addEventListener("click", () => { state.content = collectContent(); state.content.departments.push({ id: "", name: "新部门", description: "", isOpen: true }); renderDepartments(); });
  document.querySelector("#addResource").addEventListener("click", () => { state.content = collectContent(); state.content.resources.push({ id: "", title: "新资源", description: "", type: "WEBSITE", url: "", accessNote: "", permissionKey: "", accessSecret: "" }); renderResources(); });
  document.querySelector("#refreshApplications").addEventListener("click", async () => { state.applications = await api("/api/admin/applications"); renderApplications(); });
  document.querySelector("#refreshUsageRequests").addEventListener("click", async () => { state.usageRequests = await api("/api/admin/usage-requests"); renderUsageRequests(); });
  document.querySelector("#refreshAudit").addEventListener("click", async () => { state.audit = await api("/api/admin/audit?limit=200"); renderAudit(); });
  document.querySelector("#syncButton").addEventListener("click", async () => {
    if (!window.confirm("同步会重新读取服务器内容，尚未保存的本地修改会丢失。继续？")) return;
    await loadDashboard();
    setStatus("SYNC COMPLETE");
  });
  document.querySelector("#logoutButton").addEventListener("click", async () => { await api("/api/admin/logout", { method: "POST", body: "{}" }); window.location.reload(); });

  document.querySelector("#managerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = document.querySelector("#managerMessage");
    const values = Object.fromEntries(new FormData(form).entries());
    message.textContent = "CREATING MANAGER...";
    try {
      const payload = await api("/api/admin/managers", { method: "POST", body: JSON.stringify(values) });
      state.managers.push(payload.manager);
      renderManagers();
      form.reset();
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
      renderMembers();
      form.reset();
      message.textContent = "MEMBER CREATED";
    } catch (error) { message.textContent = error.message; }
  });

  document.querySelector("#inventoryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = document.querySelector("#inventoryMessage");
    message.textContent = "CREATING MATERIAL...";
    try { const payload = await api("/api/admin/inventory", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) }); state.inventory.items.push(payload.item); state.inventory = await api("/api/admin/inventory"); renderInventory(); form.reset(); message.textContent = "MATERIAL CREATED"; }
    catch (error) { message.textContent = error.message; }
  });

  document.querySelector("#fundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = document.querySelector("#fundMessage");
    message.textContent = "CREATING FUND ACCOUNT...";
    try { const payload = await api("/api/admin/funds", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) }); state.funds.accounts.push(payload.account); state.funds = await api("/api/admin/funds"); renderFunds(); form.reset(); message.textContent = "FUND ACCOUNT CREATED"; }
    catch (error) { message.textContent = error.message; }
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
      includeManagers: form.elements.includeManagers.checked,
      includeDefaultRecipients: form.elements.includeDefaultRecipients.checked,
      departmentIds: [...form.querySelectorAll('[name="departmentIds"]:checked')].map((input) => input.value),
      memberIds: [...form.querySelectorAll('[name="memberIds"]:checked')].map((input) => input.value),
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

  document.querySelector("#uploadButton").addEventListener("click", async () => {
    const file = document.querySelector("#mediaFile").files[0];
    const message = document.querySelector("#uploadMessage");
    if (!file) { message.textContent = "请选择文件"; return; }
    const body = new FormData();
    body.append("file", file);
    message.textContent = "UPLOADING...";
    try {
      const payload = await api("/api/admin/upload", { method: "POST", body });
      document.querySelector("#uploadUrl").value = payload.url;
      message.textContent = "UPLOAD COMPLETE";
    } catch (error) {
      message.textContent = error.message;
    }
  });
  document.querySelector("#copyUploadUrl").addEventListener("click", () => navigator.clipboard.writeText(document.querySelector("#uploadUrl").value));

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
          recipients: document.querySelector("#mailRecipients").value.split(/[\n,;]+/).map((email) => email.trim()).filter(Boolean)
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

  api("/api/admin/session").then(async (payload) => { state.csrf = payload.csrf; state.user = payload.user; await loadDashboard(); }).catch(() => {});
})();
