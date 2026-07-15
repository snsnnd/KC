(function () {
  "use strict";
  const form = document.querySelector("#portalLogin");
  const status = document.querySelector("#portalStatus");
  const typeInput = form.elements.accountType;
  const next = new URLSearchParams(window.location.search).get("next");

  function memberDestination() {
    return next?.startsWith("/member.html") ? next : "/member.html";
  }

  function selectType(type) {
    typeInput.value = type;
    document.querySelectorAll("[data-account-type]").forEach((button) => button.classList.toggle("is-active", button.dataset.accountType === type));
    document.querySelector("#portalKicker").textContent = type === "admin" ? "// ADMINISTRATIVE IDENTITY" : "// MEMBER IDENTITY";
    document.querySelector("#portalTitle").textContent = type === "admin" ? "管理员登录" : "成员登录";
    status.textContent = "";
  }

  document.querySelectorAll("[data-account-type]").forEach((button) => button.addEventListener("click", () => selectType(button.dataset.accountType)));
  const requestedType = new URLSearchParams(window.location.search).get("type");
  if (["admin", "member"].includes(requestedType)) selectType(requestedType);

  async function request(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "登录失败");
    return payload;
  }

  function addSession(label, detail, destination) {
    const sessions = document.querySelector("#portalSessions");
    sessions.hidden = false;
    const anchor = document.createElement("a");
    anchor.href = destination;
    const text = document.createElement("span");
    text.textContent = label;
    const meta = document.createElement("small");
    meta.textContent = detail;
    const arrow = document.createElement("b");
    arrow.textContent = "继续进入 →";
    anchor.append(text, meta, arrow);
    sessions.appendChild(anchor);
  }

  Promise.allSettled([request("/api/member/session"), request("/api/admin/session")]).then(([memberSession, adminSession]) => {
    if (memberSession.status === "fulfilled") addSession("成员工作空间", `${memberSession.value.member.name} / @${memberSession.value.member.username}`, memberDestination());
    if (adminSession.status === "fulfilled") addSession("管理控制台", `${adminSession.value.user.displayName} / ${adminSession.value.user.role.toUpperCase()}`, "/admin.html");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    const type = values.accountType;
    status.textContent = "AUTHENTICATING...";
    try {
      await request(type === "admin" ? "/api/admin/login" : "/api/member/login", { method: "POST", body: JSON.stringify({ username: values.username, password: values.password }) });
      window.location.assign(type === "admin" ? "/admin.html" : memberDestination());
    } catch (error) {
      status.textContent = error.message;
    }
  });
})();
