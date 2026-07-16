(function () {
  "use strict";
  const form = document.querySelector("#bugForm");
  const statusEl = document.querySelector("#bugStatus");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    statusEl.textContent = "SUBMITTING...";
    try {
      const response = await fetch("/api/bug-report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "提交失败");
      form.hidden = true;
      const result = document.querySelector("#bugResult");
      document.querySelector("#bugResultText").textContent = `编号 ${payload.report.id}。感谢你的反馈！`;
      result.hidden = false;
    } catch (error) {
      statusEl.textContent = error.message;
      button.disabled = false;
    }
  });
})();
