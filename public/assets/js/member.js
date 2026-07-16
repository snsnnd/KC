(function () {
  "use strict";
  const loginForm = document.querySelector("#memberLogin");
  const dashboard = document.querySelector("#memberDashboard");
  const logout = document.querySelector("#memberLogout");
  let member = null;
  let allResources = [];

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });
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
    document.querySelector("#memberPermissions").textContent = member.permissions.length ? member.permissions.join(" / ") : "PUBLIC ONLY";
    const [resources, resourceManagement, messages] = await Promise.all([api("/api/member/resources"), api("/api/member/resource-management"), api("/api/member/messages")]);
    allResources = resources;
    renderResources();
    renderResourceManagement(resourceManagement);
    renderMemberMessages(messages);
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
          endpoints.forEach((endpoint) => {
            const link = document.createElement("a");
            link.href = endpoint.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer nofollow";
            link.textContent = `${endpoint.label || "打开资源"} ↗`;
            credential.appendChild(link);
          });
          if (!endpoints.length) {
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

  async function renderResourceManagement(data) {
    const materialSelect = document.querySelector("#materialTarget");
    materialSelect.replaceChildren();
    const availableInventory = data.inventory.filter((item) => item.available > 0);
    availableInventory.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.name} / 可用 ${item.available} ${item.unit}`;
      materialSelect.appendChild(option);
    });
    const fundSelect = document.querySelector("#fundTarget");
    fundSelect.replaceChildren();
    data.funds.forEach((account) => {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = `${account.name} / ${account.currency}`;
      fundSelect.appendChild(option);
    });
    const canRequestMaterial = data.capabilities.materialRequests;
    const canRequestFund = data.capabilities.fundRequests;
    document.querySelector("#materialRequestForm").hidden = !canRequestMaterial;
    document.querySelector("#fundRequestForm").hidden = !canRequestFund;
    document.querySelector("#materialRequestForm").classList.toggle("is-disabled", !canRequestMaterial || !availableInventory.length);
    document.querySelector("#fundRequestForm").classList.toggle("is-disabled", !canRequestFund || !data.funds.length);
    document.querySelector("#materialRequestForm [data-status]").textContent = availableInventory.length ? "" : "当前暂无可申请材料";
    document.querySelector("#fundRequestForm [data-status]").textContent = data.funds.length ? "" : "当前暂无资金账户";
    document.querySelector("#memberHistoryTitle").hidden = !data.capabilities.requestHistory;
    renderRequestHistory(data.requests);
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
      code.textContent = `${request.id}\n${new Date(request.createdAt).toLocaleString("zh-CN")}`;
      identity.append(title, code);
      const target = document.createElement("p");
      target.textContent = `${request.targetName}\n${request.type === "material" ? `${request.quantity} ${request.unit}` : `${Number(request.amount).toFixed(2)} ${request.currency}`}`;
      const state = document.createElement("p");
      state.textContent = `${request.status.toUpperCase()}\n${request.reviewNote || request.purpose}`;
      const action = document.createElement("div");
      if (request.status === "pending") {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "撤销申请";
        cancel.addEventListener("click", async () => {
          if (!window.confirm("确认撤销这条申请？")) return;
          try { await api(`/api/member/usage-requests/${request.id}`, { method: "DELETE", body: "{}" }); await renderResourceManagement(await api("/api/member/resource-management")); }
          catch (error) { cancel.textContent = error.message; }
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

  async function submitUsageRequest(event, type) {
    event.preventDefault();
    const form = event.currentTarget;
    const status = form.querySelector("[data-status]");
    status.textContent = "SUBMITTING FOR APPROVAL...";
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      await api("/api/member/usage-requests", { method: "POST", body: JSON.stringify({ ...values, type }) });
      form.reset();
      status.textContent = "REQUEST SUBMITTED / 等待人员审批";
      await renderResourceManagement(await api("/api/member/resource-management"));
    } catch (error) { status.textContent = error.message; }
  }
  logout.addEventListener("click", async () => { await api("/api/member/logout", { method: "POST", body: "{}" }); window.location.assign("/portal.html?type=member"); });
  api("/api/member/session").then((payload) => openDashboard(payload.member)).catch(() => {});
})();
