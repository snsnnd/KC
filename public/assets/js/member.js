(function () {
  "use strict";
  const loginForm = document.querySelector("#memberLogin");
  const dashboard = document.querySelector("#memberDashboard");
  const logout = document.querySelector("#memberLogout");
  let member = null;

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "请求失败");
    return payload;
  }

  async function openDashboard(nextMember) {
    member = nextMember;
    loginForm.hidden = true;
    dashboard.hidden = false;
    logout.hidden = false;
    document.querySelector("#memberIdentity").textContent = `${member.name} / ONLINE`;
    document.querySelector("#memberName").textContent = member.name;
    document.querySelector("#memberUsername").textContent = `@${member.username}`;
    document.querySelector("#memberStudent").textContent = [member.studentId, member.className].filter(Boolean).join(" / ") || "未填写";
    document.querySelector("#memberPermissions").textContent = member.permissions.length ? member.permissions.join(" / ") : "PUBLIC ONLY";
    await renderResources(await api("/api/member/resources"));
    await renderResourceManagement(await api("/api/member/resource-management"));
    const requestedResource = new URLSearchParams(window.location.search).get("resource");
    if (requestedResource) document.querySelector(`[data-resource-id="${CSS.escape(requestedResource)}"] button`)?.click();
  }

  async function renderResources(resources) {
    const list = document.querySelector("#memberResources");
    list.replaceChildren();
    resources.forEach((resource) => {
      const article = document.createElement("article");
      article.className = `member-resource${resource.authorized ? " is-authorized" : " is-locked"}`;
      article.dataset.resourceId = resource.id;
      const state = document.createElement("span");
      state.textContent = resource.authorized ? "[ ACCESS: GRANTED ]" : "[ ACCESS: DENIED ]";
      const title = document.createElement("h3");
      title.textContent = resource.title;
      const description = document.createElement("p");
      description.textContent = resource.description;
      const permission = document.createElement("code");
      permission.textContent = resource.permissionKey || "PUBLIC";
      const action = document.createElement("button");
      action.type = "button";
      action.textContent = resource.authorized ? "读取访问凭据 →" : "权限不足";
      action.disabled = !resource.authorized;
      action.addEventListener("click", async () => {
        action.disabled = true;
        action.textContent = "VERIFYING...";
        try {
          const detail = await api(`/api/member/resources/${encodeURIComponent(resource.id)}`);
          let credential = article.querySelector(".resource-credential");
          if (!credential) {
            credential = document.createElement("div");
            credential.className = "resource-credential";
            article.appendChild(credential);
          }
          credential.replaceChildren();
          const secret = document.createElement("code");
          secret.textContent = detail.accessSecret ? `访问密码 / 提取码：${detail.accessSecret}` : "该资源无需密码";
          credential.appendChild(secret);
          if (detail.url) {
            const link = document.createElement("a");
            link.href = detail.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer nofollow";
            link.textContent = "打开资源 ↗";
            credential.appendChild(link);
          }
          action.textContent = "凭据已读取";
        } catch (error) {
          action.textContent = error.message;
          action.disabled = false;
        }
      });
      article.append(state, title, description, permission, action);
      list.appendChild(article);
    });
  }

  async function renderResourceManagement(data) {
    const materialSelect = document.querySelector("#materialTarget");
    materialSelect.replaceChildren();
    data.inventory.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.name} / 可用 ${item.available} ${item.unit}`;
      option.disabled = item.available <= 0;
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
    const canRequestMaterial = member.permissions.includes("*") || member.permissions.includes("material.request");
    const canRequestFund = member.permissions.includes("*") || member.permissions.includes("fund.request");
    document.querySelector("#materialRequestForm").classList.toggle("is-disabled", !canRequestMaterial || !data.inventory.length);
    document.querySelector("#fundRequestForm").classList.toggle("is-disabled", !canRequestFund || !data.funds.length);
    document.querySelector("#materialRequestForm [data-status]").textContent = canRequestMaterial ? (data.inventory.length ? "" : "当前暂无可申请材料") : "缺少权限 material.request";
    document.querySelector("#fundRequestForm [data-status]").textContent = canRequestFund ? (data.funds.length ? "" : "当前暂无资金账户") : "缺少权限 fund.request";
    renderRequestHistory(data.requests);
  }

  function renderRequestHistory(requests) {
    const list = document.querySelector("#memberRequestList");
    list.replaceChildren();
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
    if (!requests.length) list.textContent = "NO REQUESTS / 暂无使用申请";
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
  logout.addEventListener("click", async () => { await api("/api/member/logout", { method: "POST", body: "{}" }); window.location.reload(); });
  api("/api/member/session").then((payload) => openDashboard(payload.member)).catch(() => {});
})();
