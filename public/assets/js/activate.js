(function () {
  "use strict";
  const form = document.querySelector("#activationForm");
  const status = document.querySelector("#activationStatus");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const values = Object.fromEntries(new FormData(form).entries());
    button.disabled = true;
    status.textContent = "ACTIVATING...";
    try {
      const response = await fetch("/api/member/activate", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "账号激活失败");
      form.hidden = true;
      const result = document.querySelector("#activationResult");
      document.querySelector("#activationMessage").textContent = `账号 ${payload.member.username} 已激活。系统没有自动登录，请使用刚设置的密码进入成员中心。`;
      result.hidden = false;
      window.scrollTo({ top: document.querySelector("#activationArea").offsetTop - 40, behavior: "smooth" });
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
})();
