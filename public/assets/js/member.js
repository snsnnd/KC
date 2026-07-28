(function () {
  "use strict";
  const loginForm = document.querySelector("#memberLogin");
  const dashboard = document.querySelector("#memberDashboard");
  const logout = document.querySelector("#memberLogout");
  let member = null;
  let allResources = [];
  let projectWorkspaces = [];
  let projectWorkspaceRefreshGeneration = 0;
  let projectWorkspaceRefreshPromise = Promise.resolve(true);
  let resourceManagement = { inventory: [], funds: [], requests: [], capabilities: {} };
  let csrf = null;

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

  function openImageViewer(value, title) {
    const url = safeUrl(value);
    if (!url) return;
    const previousFocus = document.activeElement;
    const viewer = document.createElement("div");
    viewer.className = "image-viewer";
    viewer.setAttribute("role", "dialog");
    viewer.setAttribute("aria-modal", "true");
    viewer.setAttribute("aria-labelledby", "memberImageViewerTitle");
    const panel = document.createElement("div");
    panel.className = "image-viewer__panel";
    const heading = document.createElement("div");
    const label = document.createElement("b");
    label.id = "memberImageViewerTitle";
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

  function listFrom(payload, keys = []) {
    if (Array.isArray(payload)) return payload;
    for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
    return [];
  }

  function formatDate(value, fallback = "未设置") {
    if (!value) return fallback;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN");
  }

  function assignmentNotificationStatus(action, notification) {
    const assigneeCount = Number(notification?.assigneeCount) || 0;
    const recipientCount = Number(notification?.recipientCount) || 0;
    if (!assigneeCount) return `${action}；没有新增执行人，无需发送邮件`;
    if (!recipientCount) return `${action}；新增执行人未配置邮箱，未发送邮件`;
    if (notification.sent) return `${action}，并邮件通知 ${recipientCount} 名新增执行人`;
    if (notification.rateLimited) return `${action}；邮件通知频率受限，请稍后联系执行人`;
    return `${action}，但执行人通知邮件发送失败`;
  }

  async function api(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const headers = { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) };
    if (method !== "GET" && csrf) headers["x-csrf-token"] = csrf;
    const response = await fetch(path, { credentials: "same-origin", ...options, method, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "请求失败");
    return payload;
  }

  async function openDashboard(nextMember) {
    member = nextMember;
    loginForm.hidden = true;
    document.querySelector("#memberHero").hidden = true;
    document.querySelector("#memberLoginArea").hidden = true;
    dashboard.hidden = false;
    logout.hidden = false;
    document.querySelector("#memberIdentity").textContent = `${member.name} / ONLINE`;
    document.querySelector("#memberName").textContent = member.name;
    document.querySelector("#memberUsername").textContent = `@${member.username}`;
    document.querySelector("#memberStudent").textContent = [member.studentId, member.className].filter(Boolean).join(" / ") || "未填写";
    document.querySelector("#memberPermissions").textContent = member.permissions?.length ? member.permissions.join(" / ") : "PUBLIC ONLY";
    const [resourcesResult, managementResult, messagesResult, workspacesResult] = await Promise.allSettled([
      api("/api/member/resources"),
      api("/api/member/resource-management"),
      api("/api/member/messages"),
      refreshMemberProjectWorkspaces()
    ]);
    if (resourcesResult.status === "fulfilled") {
      allResources = listFrom(resourcesResult.value, ["resources", "items"]);
      renderResources();
    } else {
      allResources = [];
      renderResources();
      document.querySelector("#memberResourcesEmpty").textContent = `内部资源加载失败：${resourcesResult.reason.message}`;
    }
    if (managementResult.status === "fulfilled") {
      renderResourceManagement(managementResult.value);
    } else {
      document.querySelectorAll("#materialRequestForm, #fundRequestForm").forEach((form) => { form.hidden = true; });
      document.querySelector("#memberRequestsEmpty").hidden = false;
      document.querySelector("#memberRequestsEmpty").textContent = `申请模块加载失败：${managementResult.reason.message}`;
    }
    if (messagesResult.status === "fulfilled") renderMemberMessages(listFrom(messagesResult.value, ["messages", "threads"]));
    else document.querySelector("#memberMessageList").textContent = `问询记录加载失败：${messagesResult.reason.message}`;
    if (workspacesResult.status === "rejected") renderProjectWorkspaces(workspacesResult.reason.message);
    const requestedResource = new URLSearchParams(window.location.search).get("resource");
    if (requestedResource) {
      activatePanel("resources");
      const card = document.querySelector(`[data-resource-id="${CSS.escape(requestedResource)}"]`);
      card?.querySelector(":scope > button")?.click();
    }
  }

  function activatePanel(view) {
    document.querySelectorAll(".member-nav button").forEach((button) => button.classList.toggle("is-active", button.dataset.memberView === view));
    document.querySelectorAll(".member-panel").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.memberPanel === view));
  }

  document.querySelectorAll(".member-nav button").forEach((button) => {
    button.addEventListener("click", () => activatePanel(button.dataset.memberView));
  });

  function renderResources() {
    const list = document.querySelector("#memberResources");
    const empty = document.querySelector("#memberResourcesEmpty");
    const filterBar = document.querySelector("#memberResourceFilter");
    const search = document.querySelector("#memberResourceSearch");
    const typeSelect = document.querySelector("#memberResourceType");
    const count = document.querySelector("#memberResourceCount");
    filterBar.hidden = allResources.length === 0;
    empty.hidden = allResources.length > 0;
    if (!allResources.length) { list.replaceChildren(); return; }

    const categories = [...new Set(allResources.map((resource) => resource.type).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const savedType = typeSelect.value;
    typeSelect.replaceChildren(new Option("全部类型", ""), ...categories.map((category) => new Option(category, category)));
    typeSelect.value = categories.includes(savedType) ? savedType : "";

    function filter() {
      const query = search.value.trim().toLocaleLowerCase("zh-CN");
      const type = typeSelect.value;
      const articles = [...list.querySelectorAll(".member-resource")];
      articles.forEach((article) => {
        const text = `${article.dataset.resourceTitle || ""} ${article.dataset.resourceDescription || ""}`;
        article._visible = (!type || article.dataset.resourceType === type) && (!query || text.includes(query));
      });
      [...articles].reverse().forEach((article) => {
        const children = article.querySelectorAll(":scope > .member-resource-children > .member-resource");
        if (children.length && [...children].some((child) => child._visible)) article._visible = true;
      });
      articles.forEach((article) => {
        const parent = article.closest(".member-resource-children")?.closest(".member-resource");
        if (parent && parent._visible) article._visible = true;
        article.hidden = !article._visible;
      });
      count.textContent = `${articles.filter((article) => !article.hidden).length} / ${allResources.length} RESOURCES`;
    }
    search.addEventListener("input", filter);
    typeSelect.addEventListener("change", filter);

    list.replaceChildren();
    allResources.forEach((resource) => list.appendChild(createMemberResourceCard(resource, 0)));
    filter();
  }

  function createMemberResourceCard(resource, depth) {
    const article = document.createElement("article");
    article.className = `member-resource is-authorized${resource.children?.length ? " is-collection" : ""}`;
    article.dataset.resourceId = resource.id;
    article.dataset.resourceTitle = resource.title;
    article.dataset.resourceDescription = resource.description;
    article.dataset.resourceType = resource.type;
    article.dataset.depth = String(depth);
    const state = document.createElement("span");
    state.textContent = resource.children?.length ? `[ COLLECTION: ${resource.children.length} ITEMS ]` : "[ ACCESS: GRANTED ]";
    const title = document.createElement("h3");
    title.textContent = resource.title;
    const description = document.createElement("p");
    description.textContent = resource.description;
    const permission = document.createElement("code");
    permission.textContent = resource.permissionKeys?.length ? resource.permissionKeys.join(" + ") : "PUBLIC";
    article.append(state, title, description, permission);
    if (resource.hasEndpoints) {
      const action = document.createElement("button");
      action.type = "button";
      action.textContent = "读取资源链接与凭据 →";
      action.addEventListener("click", async () => {
        action.disabled = true;
        action.textContent = "VERIFYING...";
        try {
          const detail = await api(`/api/member/resources/${encodeURIComponent(resource.id)}`);
          let credential = article.querySelector(":scope > .resource-credential");
          if (!credential) {
            credential = document.createElement("div");
            credential.className = "resource-credential";
            article.insertBefore(credential, article.querySelector(":scope > .member-resource-children"));
          }
          credential.replaceChildren();
          const secret = document.createElement("code");
          secret.textContent = detail.accessSecret ? `访问密码 / 提取码：${detail.accessSecret}` : "该资源无需密码";
          credential.appendChild(secret);
          const endpoints = [...(detail.url ? [{ label: "主链接", url: detail.url }] : []), ...(detail.links || [])];
           let validEndpointCount = 0;
           endpoints.forEach((endpoint) => {
             const link = document.createElement("a");
             const href = safeUrl(endpoint.url);
             if (!href) return;
             validEndpointCount += 1;
             link.href = href;
            link.target = "_blank";
            link.rel = "noopener noreferrer nofollow";
            link.textContent = `${endpoint.label || "打开资源"} ↗`;
            credential.appendChild(link);
          });
           if (!validEndpointCount) {
            const empty = document.createElement("span");
            empty.textContent = "该节点暂未配置链接";
            credential.appendChild(empty);
          }
          action.textContent = "资源已解锁";
        } catch (error) {
          action.textContent = error.message;
          action.disabled = false;
        }
      });
      article.appendChild(action);
    }
    if (resource.children?.length) {
      const children = document.createElement("div");
      children.className = "member-resource-children";
      resource.children.forEach((child) => children.appendChild(createMemberResourceCard(child, depth + 1)));
      article.appendChild(children);
    }
    return article;
  }

  function personId(person) {
    return typeof person === "string" ? person : person?.id || person?.memberId || "";
  }

  function personLabel(person) {
    if (typeof person === "string") return person;
    return person?.name || person?.displayName || person?.username || person?.memberName || personId(person) || "未知成员";
  }

  function workspacePeople(workspace, kind) {
    const candidates = kind === "leaders"
      ? [workspace.leaders, workspace.leaderMembers, workspace.owners, workspace.managerIds, workspace.leaderIds]
      : [workspace.members, workspace.memberDetails, workspace.memberIds];
    return candidates.find(Array.isArray) || [];
  }

  function workspaceLeaderIds(workspace) {
    return new Set(workspacePeople(workspace, "leaders").map(personId).filter(Boolean));
  }

  function isWorkspaceLeader(workspace) {
    return workspace.isLeader === true || workspace.canManage === true || workspace.role === "leader" || workspaceLeaderIds(workspace).has(member?.id);
  }

  function taskAssigneeIds(task) {
    return (Array.isArray(task.assignees) ? task.assignees : Array.isArray(task.assigneeIds) ? task.assigneeIds : []).map(personId).filter(Boolean);
  }

  function addStatusOptions(select, current) {
    const statuses = [["todo", "待处理"], ["in_progress", "进行中"], ["blocked", "受阻"], ["done", "已完成"]];
    if (current && !statuses.some(([value]) => value === current)) statuses.unshift([current, current]);
    statuses.forEach(([value, label]) => select.appendChild(new Option(label, value, false, value === current)));
  }

  function createAssigneeChoices(people, selectedIds) {
    const choices = document.createElement("div");
    choices.className = "workspace-assignee-choices";
    const selected = new Set(selectedIds || []);
    people.forEach((person) => {
      const id = personId(person);
      if (!id) return;
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "assigneeIds";
      input.value = id;
      input.checked = selected.has(id);
      label.append(input, document.createTextNode(personLabel(person)));
      choices.appendChild(label);
    });
    if (!choices.children.length) choices.textContent = "暂无可指派成员";
    return choices;
  }

  function refreshMemberProjectWorkspaces(button) {
    const status = document.querySelector("#memberProjectWorkspaceStatus");
    const generation = ++projectWorkspaceRefreshGeneration;
    if (button) button.disabled = true;
    status.textContent = "LOADING PROJECT WORKSPACES...";
    const refresh = (async () => {
      try {
        const payload = await api("/api/member/project-workspaces");
        if (generation !== projectWorkspaceRefreshGeneration) return projectWorkspaceRefreshPromise;
        projectWorkspaces = listFrom(payload, ["projectWorkspaces", "workspaces", "items"]);
        renderProjectWorkspaces();
        return true;
      } catch (error) {
        if (generation !== projectWorkspaceRefreshGeneration) return projectWorkspaceRefreshPromise;
        status.textContent = `项目协作刷新失败：${error.message}`;
        return false;
      } finally {
        if (button) button.disabled = false;
      }
    })();
    projectWorkspaceRefreshPromise = refresh;
    return refresh;
  }

  async function refreshWorkspaceAfterOperation(localStatus) {
    const refreshed = await refreshMemberProjectWorkspaces();
    if (!refreshed) {
      localStatus.textContent = "操作已成功，刷新失败";
      localStatus.dataset.operationCommitted = "true";
    } else {
      delete localStatus.dataset.operationCommitted;
    }
    return refreshed;
  }

  function renderProjectWorkspaces(errorMessage = "") {
    const list = document.querySelector("#memberProjectWorkspaces");
    const status = document.querySelector("#memberProjectWorkspaceStatus");
    status.textContent = errorMessage ? `项目协作加载失败：${errorMessage}` : "";
    if (errorMessage) return;
    list.replaceChildren();
    populateProjectRequestOptions();
    if (!projectWorkspaces.length) {
      status.textContent = "当前没有与你关联的项目工作区。";
      return;
    }
    projectWorkspaces.forEach((workspace) => list.appendChild(createProjectWorkspaceCard(workspace)));
  }

  function createProjectWorkspaceCard(workspace) {
    const article = document.createElement("article");
    article.className = "member-workspace-card";
    const members = workspacePeople(workspace, "members");
    const leaders = workspacePeople(workspace, "leaders").map((person) => typeof person === "string" ? members.find((item) => personId(item) === person) || person : person);
    const leader = isWorkspaceLeader(workspace);
    const header = document.createElement("header");
    const heading = document.createElement("div");
    const state = document.createElement("span");
    state.textContent = `[ ${String(workspace.status || "unknown").toUpperCase()} / ${leader ? "LEADER" : "MEMBER"} ]`;
    const title = document.createElement("h3");
    title.textContent = workspace.name || "未命名工作区";
    const description = document.createElement("p");
    description.textContent = workspace.description || "暂无项目说明";
    heading.append(state, title, description);
    const progress = document.createElement("div");
    progress.className = "workspace-progress";
    const progressValue = Math.max(0, Math.min(100, Number(workspace.progress) || 0));
    const progressLabel = document.createElement("b");
    progressLabel.textContent = `${progressValue}%`;
    const progressTrack = document.createElement("i");
    const progressBar = document.createElement("span");
    progressBar.style.width = `${progressValue}%`;
    progressTrack.appendChild(progressBar);
    progress.append(progressLabel, progressTrack);
    header.append(heading, progress);
    const meta = document.createElement("dl");
    [["负责人", leaders.map(personLabel).join(" / ") || "未指定"], ["成员", members.map(personLabel).join(" / ") || "未指定"], ["公开项目", workspace.projectId || workspace.project?.id || "未关联"], ["更新时间", formatDate(workspace.updatedAt || workspace.createdAt)]].forEach(([term, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      meta.append(dt, dd);
    });
    const body = document.createElement("div");
    body.className = "member-workspace-body";
    body.append(createAllocationSection(workspace), createTaskSection(workspace, members, leader), createDeliverableSection(workspace, leader), createUpdateSection(workspace));
    article.append(header, meta, body);
    return article;
  }

  function createAllocationSection(workspace) {
    const section = document.createElement("section");
    section.className = "workspace-section";
    const title = document.createElement("h4");
    const allocations = Array.isArray(workspace.allocations) ? workspace.allocations : [];
    title.textContent = `配额 / ALLOCATIONS (${allocations.length})`;
    const list = document.createElement("div");
    list.className = "workspace-allocation-list";
    allocations.forEach((allocation) => {
      const item = document.createElement("article");
      const allocated = Number(allocation.allocated) || 0;
      const used = Number(allocation.used) || 0;
      const pending = Number(allocation.pending) || 0;
      const remaining = Number.isFinite(Number(allocation.remaining)) ? Number(allocation.remaining) : Math.max(0, allocated - used - pending);
      const unit = allocation.unit || allocation.currency || allocation.target?.unit || allocation.target?.currency || "";
      const name = document.createElement("strong");
      name.textContent = `${allocation.targetName || allocation.resourceName || allocation.name || allocation.target?.name || allocation.targetId || "未命名配额"} / ${String(allocation.type || "resource").toUpperCase()}`;
      const values = document.createElement("p");
      values.textContent = `ALLOCATED ${allocated} / USED ${used} / PENDING ${pending} / REMAINING ${remaining} ${unit}`;
      const track = document.createElement("i");
      const bar = document.createElement("span");
      bar.style.width = `${allocated > 0 ? Math.min(100, ((used + pending) / allocated) * 100) : 0}%`;
      track.appendChild(bar);
      item.append(name, values, track);
      list.appendChild(item);
    });
    if (!allocations.length) list.textContent = "暂无项目配额";
    section.append(title, list);
    return section;
  }

  function createTaskSection(workspace, people, leader) {
    const section = document.createElement("section");
    section.className = "workspace-section";
    const tasks = Array.isArray(workspace.tasks) ? workspace.tasks : [];
    const title = document.createElement("h4");
    title.textContent = `任务 / TASKS (${tasks.length})`;
    const list = document.createElement("div");
    list.className = "workspace-task-list";
    tasks.forEach((task) => list.appendChild(createWorkspaceTask(workspace, task, people, leader)));
    if (!tasks.length) list.textContent = "暂无任务";
    section.append(title, list);
    if (leader) section.appendChild(createTaskForm(workspace, people));
    return section;
  }

  function createWorkspaceTask(workspace, task, people, leader) {
    const item = document.createElement("article");
    item.className = "workspace-task";
    const header = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = task.title || "未命名任务";
    const status = document.createElement("span");
    status.textContent = String(task.status || "todo").toUpperCase();
    header.append(title, status);
    const description = document.createElement("p");
    description.textContent = task.description || "暂无说明";
    const assigneeIds = taskAssigneeIds(task);
    const assigneeNames = (Array.isArray(task.assignees) ? task.assignees.map(personLabel) : assigneeIds.map((id) => personLabel(people.find((person) => personId(person) === id) || id))).join(" / ");
    const meta = document.createElement("small");
    meta.textContent = `负责人：${assigneeNames || "未指派"} / 截止：${formatDate(task.dueDate, "未设置")}`;
    item.append(header, description, meta);
    const canUpdateStatus = leader || task.isAssignee === true || assigneeIds.includes(member?.id);
    if (leader) {
      const form = document.createElement("form");
      form.className = "workspace-inline-form workspace-task-edit";
      const titleInput = document.createElement("input");
      titleInput.value = task.title || "";
      titleInput.required = true;
      titleInput.minLength = 2;
      titleInput.maxLength = 160;
      titleInput.setAttribute("aria-label", "任务标题");
      const descriptionInput = document.createElement("textarea");
      descriptionInput.value = task.description || "";
      descriptionInput.maxLength = 2000;
      descriptionInput.setAttribute("aria-label", "任务说明");
      const dueDate = document.createElement("input");
      dueDate.type = "date";
      dueDate.value = task.dueDate ? String(task.dueDate).slice(0, 10) : "";
      dueDate.setAttribute("aria-label", "截止日期");
      const statusSelect = document.createElement("select");
      statusSelect.setAttribute("aria-label", "任务状态");
      addStatusOptions(statusSelect, task.status || "todo");
      const choices = createAssigneeChoices(people, assigneeIds);
      const button = document.createElement("button");
      button.type = "submit";
      button.textContent = "保存完整任务";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "workspace-task-delete";
      remove.textContent = "删除任务";
      const formStatus = document.createElement("p");
      formStatus.className = "workspace-local-status";
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        delete formStatus.dataset.operationCommitted;
        button.disabled = true;
        remove.disabled = true;
        formStatus.textContent = "SAVING TASK...";
        try {
          const payload = await api(`/api/member/project-workspaces/${encodeURIComponent(workspace.id)}/tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", body: JSON.stringify({ revision: workspace.revision, title: titleInput.value, description: descriptionInput.value, assigneeIds: [...choices.querySelectorAll("input:checked")].map((input) => input.value), dueDate: dueDate.value || null, status: statusSelect.value }) });
          await refreshWorkspaceAfterOperation(formStatus);
          document.querySelector("#memberProjectWorkspaceStatus").textContent = assignmentNotificationStatus("任务已保存", payload.assignmentNotification);
        } catch (error) {
          delete formStatus.dataset.operationCommitted;
          formStatus.textContent = error.message;
        } finally {
          const committed = formStatus.dataset.operationCommitted === "true";
          button.disabled = committed;
          remove.disabled = committed;
        }
      });
      remove.addEventListener("click", async () => {
        if (!window.confirm(`确认删除任务“${task.title}”？`)) return;
        button.disabled = true;
        remove.disabled = true;
        formStatus.textContent = "DELETING TASK...";
        let succeeded = false;
        try {
          await api(`/api/member/project-workspaces/${encodeURIComponent(workspace.id)}/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE", body: JSON.stringify({ revision: workspace.revision }) });
          succeeded = true;
          await refreshWorkspaceAfterOperation(formStatus);
        } catch (error) {
          formStatus.textContent = error.message;
        } finally {
          button.disabled = succeeded;
          remove.disabled = succeeded;
        }
      });
      form.append(titleInput, descriptionInput, dueDate, statusSelect, choices, button, remove, formStatus);
      item.appendChild(form);
    } else if (canUpdateStatus) {
      const form = document.createElement("form");
      form.className = "workspace-status-form";
      const select = document.createElement("select");
      addStatusOptions(select, task.status || "todo");
      const button = document.createElement("button");
      button.type = "submit";
      button.textContent = "更新状态";
      const formStatus = document.createElement("span");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        delete formStatus.dataset.operationCommitted;
        button.disabled = true;
        formStatus.textContent = "提交中...";
        try {
          await api(`/api/member/project-workspaces/${encodeURIComponent(workspace.id)}/tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", body: JSON.stringify({ revision: workspace.revision, status: select.value }) });
          await refreshWorkspaceAfterOperation(formStatus);
        } catch (error) {
          delete formStatus.dataset.operationCommitted;
          formStatus.textContent = error.message;
        } finally {
          button.disabled = formStatus.dataset.operationCommitted === "true";
        }
      });
      form.append(select, button, formStatus);
      item.appendChild(form);
    }
    return item;
  }

  function createTaskForm(workspace, people) {
    const form = document.createElement("form");
    form.className = "workspace-inline-form workspace-create-task";
    const heading = document.createElement("strong");
    heading.textContent = "新建任务";
    const title = document.createElement("input");
    title.name = "title";
    title.placeholder = "任务标题";
    title.maxLength = 160;
    title.minLength = 2;
    title.required = true;
    const description = document.createElement("textarea");
    description.name = "description";
    description.placeholder = "任务说明";
    description.maxLength = 2000;
    const dueDate = document.createElement("input");
    dueDate.name = "dueDate";
    dueDate.type = "date";
    const choices = createAssigneeChoices(people, []);
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "CREATE TASK";
    const status = document.createElement("p");
    status.className = "workspace-local-status";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      delete status.dataset.operationCommitted;
      button.disabled = true;
      status.textContent = "CREATING TASK...";
      try {
        const payload = await api(`/api/member/project-workspaces/${encodeURIComponent(workspace.id)}/tasks`, { method: "POST", body: JSON.stringify({ title: title.value, description: description.value, assigneeIds: [...choices.querySelectorAll("input:checked")].map((input) => input.value), dueDate: dueDate.value || null }) });
        await refreshWorkspaceAfterOperation(status);
        document.querySelector("#memberProjectWorkspaceStatus").textContent = assignmentNotificationStatus("任务已创建", payload.assignmentNotification);
      } catch (error) {
        delete status.dataset.operationCommitted;
        status.textContent = error.message;
      } finally {
        button.disabled = status.dataset.operationCommitted === "true";
      }
    });
    form.append(heading, title, description, dueDate, choices, button, status);
    return form;
  }

  function createDeliverableSection(workspace, leader) {
    const section = document.createElement("section");
    section.className = "workspace-section workspace-deliverables";
    const deliverables = Array.isArray(workspace.deliverables) ? workspace.deliverables : [];
    const title = document.createElement("h4");
    title.textContent = `成果链接 / DELIVERABLES (${deliverables.length})`;
    const list = document.createElement("div");
    list.className = "workspace-deliverable-list";
    deliverables.forEach((deliverable) => {
      const item = document.createElement("article");
      const link = document.createElement("a");
      link.href = safeUrl(deliverable.url) || "#";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `${deliverable.title || "未命名成果"} ↗`;
      const description = document.createElement("p");
      description.textContent = deliverable.description || "暂无说明";
      const meta = document.createElement("span");
      meta.textContent = `${String(deliverable.type || "other").toUpperCase()} / ${personLabel(deliverable.submittedBy)} / ${formatDate(deliverable.createdAt)}${deliverable.archivedResourceId ? " / 已归档到内部资料" : " / 已回传管理端"}`;
      item.append(link, description, meta);
      if (!deliverable.archivedResourceId && (leader || deliverable.submittedBy?.id === member?.id)) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "删除成果";
        remove.addEventListener("click", async () => {
          if (!window.confirm(`确认删除成果“${deliverable.title}”？`)) return;
          remove.disabled = true;
          try {
            await api(`/api/member/project-workspaces/${encodeURIComponent(workspace.id)}/deliverables/${encodeURIComponent(deliverable.id)}`, { method: "DELETE", body: "{}" });
            await refreshMemberProjectWorkspaces();
          } catch (error) { document.querySelector("#memberProjectWorkspaceStatus").textContent = error.message; }
          finally { remove.disabled = false; }
        });
        item.appendChild(remove);
      }
      list.appendChild(item);
    });
    if (!deliverables.length) list.textContent = "暂无资料、网站、代码仓库或演示链接";
    const form = document.createElement("form");
    form.className = "workspace-deliverable-form";
    const heading = document.createElement("strong");
    heading.textContent = "提交项目成果";
    const name = document.createElement("input");
    name.placeholder = "成果名称";
    name.setAttribute("aria-label", "成果名称");
    name.minLength = 2;
    name.maxLength = 160;
    name.required = true;
    const type = document.createElement("select");
    type.setAttribute("aria-label", "成果类型");
    [["资料文档", "document"], ["网站", "website"], ["代码仓库", "repository"], ["演示地址", "demo"], ["其他", "other"]].forEach(([label, value]) => type.appendChild(new Option(label, value)));
    const url = document.createElement("input");
    url.type = "url";
    url.placeholder = "https://... 资料、网站或仓库链接";
    url.setAttribute("aria-label", "成果链接");
    url.required = true;
    const description = document.createElement("textarea");
    description.placeholder = "说明完成了什么、如何使用或查看";
    description.setAttribute("aria-label", "成果说明");
    description.maxLength = 1000;
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "提交并回传管理端";
    const status = document.createElement("p");
    status.className = "workspace-local-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      status.textContent = "SUBMITTING DELIVERABLE...";
      try {
        await api(`/api/member/project-workspaces/${encodeURIComponent(workspace.id)}/deliverables`, { method: "POST", body: JSON.stringify({ title: name.value, type: type.value, url: url.value, description: description.value }) });
        await refreshWorkspaceAfterOperation(status);
      } catch (error) { status.textContent = error.message; }
      finally { submit.disabled = status.dataset.operationCommitted === "true"; }
    });
    form.append(heading, name, type, url, description, submit, status);
    section.append(title, list, form);
    return section;
  }

  function createUpdateSection(workspace) {
    const section = document.createElement("section");
    section.className = "workspace-section workspace-updates";
    const updates = Array.isArray(workspace.updates) ? workspace.updates : [];
    const title = document.createElement("h4");
    title.textContent = `小组动态 / UPDATES (${updates.length})`;
    const timeline = document.createElement("div");
    timeline.className = "workspace-update-timeline";
    updates.forEach((update) => {
      const entry = document.createElement("article");
      const meta = document.createElement("span");
      meta.textContent = `${personLabel(update.actor || update.author || update.member || update.memberName)} / ${formatDate(update.createdAt || update.updatedAt)}${update.progress !== undefined && update.progress !== null ? ` / PROGRESS ${update.progress}%` : ""}`;
      const message = document.createElement("p");
      message.textContent = update.message || update.content || update.text || "";
      entry.append(meta, message);
      timeline.appendChild(entry);
    });
    if (!updates.length) timeline.textContent = "暂无小组动态";
    const form = document.createElement("form");
    form.className = "workspace-update-form";
    const message = document.createElement("textarea");
    message.name = "message";
    message.placeholder = "发送小组消息或进度动态";
    message.maxLength = 3000;
    message.minLength = 2;
    message.required = true;
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "POST UPDATE";
    const status = document.createElement("p");
    status.className = "workspace-local-status";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      delete status.dataset.operationCommitted;
      button.disabled = true;
      status.textContent = "POSTING UPDATE...";
      const body = { message: message.value };
      try {
        await api(`/api/member/project-workspaces/${encodeURIComponent(workspace.id)}/updates`, { method: "POST", body: JSON.stringify(body) });
        await refreshWorkspaceAfterOperation(status);
      } catch (error) {
        delete status.dataset.operationCommitted;
        status.textContent = error.message;
      } finally {
        button.disabled = status.dataset.operationCommitted === "true";
      }
    });
    form.append(message, button, status);
    section.append(title, timeline, form);
    return section;
  }

  function populateProjectRequestOptions() {
    document.querySelectorAll(".project-request-select").forEach((select) => {
      const selected = select.value;
      select.replaceChildren(new Option("不关联项目", ""));
      projectWorkspaces.forEach((workspace) => select.appendChild(new Option(workspace.name || workspace.id, workspace.id)));
      select.value = projectWorkspaces.some((workspace) => workspace.id === selected) ? selected : "";
      updateUsageTargets(select.closest("form"));
    });
  }

  function allocationRemaining(allocation) {
    if (allocation?.remaining !== undefined && allocation.remaining !== null && allocation.remaining !== "" && Number.isFinite(Number(allocation.remaining))) return Math.max(0, Number(allocation.remaining));
    return Math.max(0, (Number(allocation?.allocated) || 0) - (Number(allocation?.used) || 0) - (Number(allocation?.pending) || 0));
  }

  function updateUsageAmountLimit(form) {
    const type = form.id === "materialRequestForm" ? "material" : "fund";
    const amountInput = form.elements[type === "material" ? "quantity" : "amount"];
    const selected = form.elements.targetId.selectedOptions[0];
    const remaining = selected?.dataset.remaining;
    if (remaining === undefined) {
      amountInput.removeAttribute("max");
      return;
    }
    amountInput.max = remaining;
    if (Number(amountInput.value) > Number(remaining)) amountInput.value = "";
  }

  function renderMaterialPreview(form) {
    if (!form || form.id !== "materialRequestForm") return;
    const preview = document.querySelector("#materialPreview");
    const item = resourceManagement.inventory.find((entry) => entry.id === form.elements.targetId.value);
    const url = safeUrl(item?.componentImage);
    preview.replaceChildren();
    preview.hidden = !item;
    if (!item) return;
    const meta = document.createElement("span");
    meta.textContent = [item.category || "未分类", item.sku || "无 SKU"].join(" / ");
    preview.appendChild(meta);
    if (url) {
      const button = document.createElement("button");
      button.type = "button";
      const image = document.createElement("img");
      image.src = url;
      image.alt = `${item.name} 元器件图片`;
      const label = document.createElement("b");
      label.textContent = "查看元器件大图";
      button.append(image, label);
      button.addEventListener("click", () => openImageViewer(url, `${item.name} / 元器件图片`));
      preview.appendChild(button);
    } else {
      const empty = document.createElement("small");
      empty.textContent = "该材料暂未上传元器件图片";
      preview.appendChild(empty);
    }
  }

  function updateUsageTargets(form) {
    if (!form) return;
    const type = form.id === "materialRequestForm" ? "material" : "fund";
    const projectId = form.elements.projectWorkspaceId?.value || "";
    const workspace = projectWorkspaces.find((item) => item.id === projectId);
    const allocations = (workspace?.allocations || []).filter((allocation) => allocation.type === type && allocationRemaining(allocation) > 0);
    const allocationsByTarget = new Map(allocations.map((allocation) => [allocation.targetId || allocation.target?.id, allocation]));
    let source = type === "material" ? resourceManagement.inventory.filter((item) => Number(item.available) > 0) : resourceManagement.funds;
    if (type === "material") {
      const query = document.querySelector("#materialSearch").value.trim().toLocaleLowerCase("zh-CN");
      const category = document.querySelector("#materialCategory").value;
      source = source.filter((item) => (!category || item.category === category) && (!query || [item.name, item.sku, item.category].some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(query))));
    }
    const filtered = projectId ? source.filter((item) => allocationsByTarget.has(item.id)) : source.filter((item) => Number(item.unlinkedAvailable) > 0);
    const select = form.elements.targetId;
    const selected = select.value;
    select.replaceChildren();
    filtered.forEach((item) => {
      const allocation = allocationsByTarget.get(item.id);
      const remaining = allocation ? allocationRemaining(allocation) : Number(item.unlinkedAvailable);
      const unit = allocation?.unit || allocation?.currency || item.unit || item.currency || "";
      const label = allocation ? `${item.name} / 项目剩余 ${remaining} ${unit}` : `${item.name} / 可申请 ${remaining} ${unit}`;
      const option = new Option(label, item.id);
      option.dataset.remaining = String(remaining);
      select.appendChild(option);
    });
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
    const unavailable = !filtered.length;
    const availability = form.querySelector("[data-availability]");
    availability.textContent = unavailable ? projectId ? "该项目暂无剩余可申请配额" : type === "material" ? "当前暂无可申请材料" : "当前暂无资金账户" : projectId ? "申请上限按项目剩余配额控制" : "";
    select.disabled = unavailable;
    const amountInput = form.elements[type === "material" ? "quantity" : "amount"];
    amountInput.disabled = unavailable;
    form.querySelector('button[type="submit"]').disabled = unavailable;
    form.classList.remove("is-disabled");
    updateUsageAmountLimit(form);
    renderMaterialPreview(form);
  }

  function renderResourceManagement(data) {
    resourceManagement = {
      inventory: Array.isArray(data?.inventory) ? data.inventory : [],
      funds: Array.isArray(data?.funds) ? data.funds : [],
      requests: Array.isArray(data?.requests) ? data.requests : [],
      capabilities: data?.capabilities || {}
    };
    const canRequestMaterial = resourceManagement.capabilities.materialRequests;
    const canRequestFund = resourceManagement.capabilities.fundRequests;
    document.querySelector("#materialRequestForm").hidden = !canRequestMaterial;
    document.querySelector("#fundRequestForm").hidden = !canRequestFund;
    document.querySelector("#memberHistoryTitle").hidden = !resourceManagement.capabilities.requestHistory;
    const categorySelect = document.querySelector("#materialCategory");
    const selectedCategory = categorySelect.value;
    const categories = [...new Set(resourceManagement.inventory.map((item) => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    categorySelect.replaceChildren(new Option("全部分类", ""), ...categories.map((category) => new Option(category, category)));
    categorySelect.value = categories.includes(selectedCategory) ? selectedCategory : "";
    renderRequestHistory(resourceManagement.requests);
    populateProjectRequestOptions();
  }

  function upsertUsageRequest(nextRequest) {
    if (!nextRequest?.id) return;
    const index = resourceManagement.requests.findIndex((request) => request.id === nextRequest.id);
    if (index >= 0) resourceManagement.requests[index] = nextRequest;
    else resourceManagement.requests.unshift(nextRequest);
  }

  function adjustLocalAllocation(request, direction) {
    if (!request?.projectWorkspaceId) return;
    const workspace = projectWorkspaces.find((item) => item.id === request.projectWorkspaceId);
    const allocation = (workspace?.allocations || []).find((item) => item.type === request.type && item.targetId === request.targetId);
    if (!allocation) return;
    const amount = Number(request.type === "material" ? request.quantity : request.amount) || 0;
    const previousRemaining = allocationRemaining(allocation);
    allocation.pending = Math.max(0, (Number(allocation.pending) || 0) + amount * direction);
    allocation.remaining = Math.max(0, previousRemaining - amount * direction);
  }

  async function refreshResourceManagement(preservedRequests = []) {
    const payload = await api("/api/member/resource-management");
    const requests = Array.isArray(payload?.requests) ? [...payload.requests] : [];
    preservedRequests.forEach((request) => {
      if (request?.id && !requests.some((item) => item.id === request.id)) requests.unshift(request);
    });
    renderResourceManagement({ ...payload, requests });
  }

  function renderRequestHistory(requests) {
    const list = document.querySelector("#memberRequestList");
    const empty = document.querySelector("#memberRequestsEmpty");
    list.replaceChildren();
    empty.hidden = requests.length > 0;
    requests.forEach((request) => {
      const article = document.createElement("article");
      article.className = "member-request-record";
      const identity = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = request.type === "material" ? "材料申请" : "资金申请";
      const code = document.createElement("code");
      code.textContent = `${request.id}\n${new Date(request.createdAt).toLocaleString("zh-CN")}${request.projectWorkspaceName ? `\n${request.projectWorkspaceName}` : ""}`;
      identity.append(title, code);
      const target = document.createElement("p");
      target.textContent = `${request.targetName}\n${request.type === "material" ? `${request.quantity} ${request.unit}` : `${Number(request.amount).toFixed(2)} ${request.currency}`}`;
      const state = document.createElement("p");
      state.textContent = `${request.status.toUpperCase()}\n${request.reviewNote || request.purpose}${request.pickupInstruction ? `\n\n领取位置：${request.pickupInstruction}` : ""}`;
      const action = document.createElement("div");
      if (request.status === "approved") {
        [[request.componentImage, "查看元器件图片"], [request.locationImage, "查看领取位置图片"]].forEach(([value, label]) => {
          const url = safeUrl(value);
          if (!url) return;
          const view = document.createElement("button");
          view.type = "button";
          view.textContent = label;
          view.addEventListener("click", () => openImageViewer(url, `${request.targetName} / ${label}`));
          action.appendChild(view);
        });
      }
      if (request.status === "pending") {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "撤销申请";
        cancel.addEventListener("click", async () => {
          if (!window.confirm("确认撤销这条申请？")) return;
          cancel.disabled = true;
          const moduleStatus = document.querySelector("#memberRequestStatus");
          let payload;
          try {
            payload = await api(`/api/member/usage-requests/${encodeURIComponent(request.id)}`, { method: "DELETE" });
          } catch (error) {
            moduleStatus.textContent = `撤销失败：${error.message}`;
            cancel.disabled = false;
            return;
          }
          adjustLocalAllocation(request, -1);
          const cancelled = payload.request || payload.usageRequest || (payload.id ? payload : { ...request, status: "cancelled" });
          upsertUsageRequest(cancelled);
          renderRequestHistory(resourceManagement.requests);
          moduleStatus.textContent = "申请已撤销";
          try {
            await refreshResourceManagement([cancelled]);
          } catch {
            moduleStatus.textContent = "申请已撤销但列表刷新失败";
          } finally {
            cancel.disabled = false;
          }
        });
        action.appendChild(cancel);
      }
      article.append(identity, target, state, action);
      list.appendChild(article);
    });
    if (!requests.length) list.textContent = "";
  }

  function renderMemberMessages(messages, sentThreadId = "") {
    const list = document.querySelector("#memberMessageList");
    list.replaceChildren();
    messages.forEach((thread) => {
      const article = document.createElement("article");
      article.className = "member-message-thread";
      const header = document.createElement("header");
      header.className = "member-message-thread__header";
      const identity = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = thread.subject;
      const code = document.createElement("code");
      code.textContent = `${thread.id} / ${new Date(thread.createdAt).toLocaleString("zh-CN")}`;
      identity.append(title, code);
      const threadStatus = document.createElement("span");
      threadStatus.className = `member-message-thread__status is-${thread.status}`;
      threadStatus.textContent = thread.status === "closed" ? "已结束" : "沟通中";
      header.append(identity, threadStatus);
      const question = document.createElement("div");
      question.className = "member-message-entry is-original";
      const questionMeta = document.createElement("span");
      questionMeta.textContent = "原始问询";
      const questionText = document.createElement("p");
      questionText.textContent = thread.message;
      question.append(questionMeta, questionText);
      const replies = document.createElement("div");
      replies.className = "member-message-timeline";
      (thread.replies || []).forEach((reply) => {
        const isMember = reply.sender === "member" || Boolean(reply.member);
        const response = document.createElement("div");
        response.className = `member-message-entry ${isMember ? "is-member" : "is-admin"}`;
        const responseMeta = document.createElement("span");
        responseMeta.textContent = `${isMember ? "我" : reply.admin?.displayName || "管理员"} / ${new Date(reply.createdAt).toLocaleString("zh-CN")}`;
        const responseText = document.createElement("p");
        responseText.textContent = reply.message;
        response.append(responseMeta, responseText);
        replies.appendChild(response);
      });
      if (!thread.replies?.length) {
        const empty = document.createElement("p");
        empty.className = "member-message-timeline__empty";
        empty.textContent = "管理员尚未回复，你仍可继续补充信息。";
        replies.appendChild(empty);
      }
      const composer = document.createElement("form");
      composer.className = "member-message-composer";
      const input = document.createElement("textarea");
      input.className = "member-message-composer__input";
      input.maxLength = 5000;
      input.required = true;
      input.setAttribute("aria-label", "继续回复");
      input.placeholder = thread.status === "closed" ? "继续发送将重新打开此问询" : "继续补充信息或回复管理员";
      const send = document.createElement("button");
      send.type = "submit";
      send.className = "member-message-composer__send";
      send.textContent = "继续发送 →";
      const composerStatus = document.createElement("p");
      composerStatus.className = "member-message-composer__status";
      composerStatus.setAttribute("role", "status");
      if (sentThreadId === thread.id) composerStatus.textContent = "回复已发送，管理员可在后台查看。";
      composer.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = input.value.trim();
        if (message.length < 2) {
          composerStatus.textContent = "请至少输入 2 个字符。";
          input.focus();
          return;
        }
        send.disabled = true;
        send.textContent = "发送中...";
        composerStatus.textContent = "正在写入问询记录...";
        try {
          const payload = await api(`/api/member/messages/${encodeURIComponent(thread.id)}/replies`, { method: "POST", body: JSON.stringify({ message }) });
          const index = messages.findIndex((item) => item.id === thread.id);
          if (index >= 0) messages[index] = payload.thread;
          renderMemberMessages(messages, thread.id);
        } catch (error) {
          composerStatus.textContent = error.message;
          send.textContent = "重新发送 →";
          send.disabled = false;
        }
      });
      composer.append(input, send, composerStatus);
      article.append(header, question, replies, composer);
      list.appendChild(article);
    });
    if (!messages.length) list.textContent = "NO QUESTIONS / 暂无问询记录";
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = document.querySelector("#memberLoginStatus");
    status.textContent = "AUTHORIZING...";
    try {
      const payload = await api("/api/member/login", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(loginForm).entries())) });
      csrf = payload.csrf;
      await openDashboard(payload.member);
    } catch (error) { status.textContent = error.message; }
  });
  document.querySelector("#memberMessageForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = form.querySelector("[data-status]");
    status.textContent = "SENDING QUESTION...";
    try {
      const payload = await api("/api/member/messages", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset();
      status.textContent = payload.notified ? "问题已发送，并已通知负责管理员" : "问题已保存，管理员可在后台查看";
      renderMemberMessages(await api("/api/member/messages"));
    } catch (error) { status.textContent = error.message; }
  });
  document.querySelector("#memberPasswordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = form.querySelector("[data-status]");
    status.textContent = "UPDATING PASSWORD...";
    try {
      const payload = await api("/api/member/password", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset();
      status.textContent = "密码已更新，成员与管理入口已同步";
      await openDashboard(payload.member);
    } catch (error) { status.textContent = error.message; }
  });
  document.querySelector("#materialRequestForm").addEventListener("submit", (event) => submitUsageRequest(event, "material"));
  document.querySelector("#fundRequestForm").addEventListener("submit", (event) => submitUsageRequest(event, "fund"));
  document.querySelectorAll(".project-request-select").forEach((select) => select.addEventListener("change", () => updateUsageTargets(select.closest("form"))));
  document.querySelectorAll("#materialTarget, #fundTarget").forEach((select) => select.addEventListener("change", () => updateUsageAmountLimit(select.closest("form"))));
  document.querySelector("#materialTarget").addEventListener("change", () => renderMaterialPreview(document.querySelector("#materialRequestForm")));
  document.querySelector("#materialSearch").addEventListener("input", () => updateUsageTargets(document.querySelector("#materialRequestForm")));
  document.querySelector("#materialCategory").addEventListener("change", () => updateUsageTargets(document.querySelector("#materialRequestForm")));
  document.querySelector("#refreshProjectWorkspaces").addEventListener("click", (event) => refreshMemberProjectWorkspaces(event.currentTarget));

  async function submitUsageRequest(event, type) {
    event.preventDefault();
    const form = event.currentTarget;
    const status = form.querySelector("[data-status]");
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = "SUBMITTING FOR APPROVAL...";
    const values = Object.fromEntries(new FormData(form).entries());
    let payload;
    try {
      payload = await api("/api/member/usage-requests", { method: "POST", body: JSON.stringify({ ...values, projectWorkspaceId: values.projectWorkspaceId || null, type }) });
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
      return;
    }
    const created = payload.request || payload.usageRequest || (payload.id ? payload : null);
    if (created) {
      upsertUsageRequest(created);
      adjustLocalAllocation(created, 1);
      document.querySelector("#memberHistoryTitle").hidden = false;
      renderRequestHistory(resourceManagement.requests);
    }
    form.reset();
    status.textContent = "申请已提交，等待审批";
    updateUsageTargets(form);
    try {
      await refreshResourceManagement(created ? [created] : []);
    } catch {
      status.textContent = "已提交但列表刷新失败";
    } finally {
      button.disabled = false;
      updateUsageTargets(form);
    }
  }
  logout.addEventListener("click", async () => { await api("/api/member/logout", { method: "POST", body: "{}" }); window.location.assign("/portal.html?type=member"); });
  api("/api/member/session").then((payload) => { csrf = payload.csrf; return openDashboard(payload.member); }).catch(() => {});
})();
