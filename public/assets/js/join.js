(async function () {
  "use strict";
  const departmentList = document.querySelector("#departmentList");
  const form = document.querySelector("#applicationForm");
  const status = document.querySelector("#formStatus");
  let departments = [];

  try {
    const response = await fetch("/api/content", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const content = await response.json();
    departments = content.departments.filter((department) => department.isOpen);
    departmentList.replaceChildren();
    departments.forEach((department, index) => {
      const label = document.createElement("label");
      label.className = "department-card";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "departmentId";
      input.value = department.id;
      input.required = true;
      if (index === 0) input.checked = true;
      const code = document.createElement("span");
      code.textContent = `[ MODULE ${String(index + 1).padStart(2, "0")} ]`;
      const name = document.createElement("h3");
      name.textContent = department.name;
      const description = document.createElement("p");
      description.textContent = department.description;
      label.append(input, code, name, description);
      departmentList.appendChild(label);
    });
    if (!departments.length) departmentList.textContent = "CURRENTLY CLOSED / 当前暂无开放部门";
  } catch {
    departmentList.textContent = "MODULE LOAD FAILED / 请稍后刷新";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    status.textContent = "TRANSMITTING...";
    const payload = Object.fromEntries(new FormData(form).entries());
    try {
      const response = await fetch("/api/applications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "提交失败");
      const area = document.querySelector("#applicationArea");
      area.replaceChildren();
      const success = document.createElement("div");
      success.className = "success-panel";
      const light = document.createElement("i");
      const heading = document.createElement("h2");
      heading.textContent = "申请已进入系统";
      const detail = document.createElement("p");
      detail.textContent = `申请编号 ${result.id}\n申请已保存至管理后台${result.notified ? "，并同步发送至管理员邮箱" : ""}。管理者将在审核后联系你。`;
      success.append(light, heading, detail);
      area.appendChild(success);
      window.scrollTo({ top: area.offsetTop - 40, behavior: "smooth" });
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
})();
