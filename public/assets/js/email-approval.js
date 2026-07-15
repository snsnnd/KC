(function () {
  "use strict";
  const hash = new URLSearchParams(window.location.hash.slice(1));
  let token = hash.get("token") || "";
  window.history.replaceState(null, "", window.location.pathname);
  const loading = document.querySelector("#approvalLoading");
  const content = document.querySelector("#approvalContent");
  const result = document.querySelector("#approvalResult");
  const status = document.querySelector("#approvalStatus");
  let approval = null;

  async function request(path, body) {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || "审批请求失败");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function showResult(title, message, successful = false) {
    loading.hidden = true;
    content.hidden = true;
    result.hidden = false;
    result.classList.toggle("is-success", successful);
    document.querySelector("#approvalResultTitle").textContent = title;
    document.querySelector("#approvalResultMessage").textContent = message;
  }

  function renderApproval() {
    const isApprove = approval.action === "approved";
    document.querySelector("#approvalAction").textContent = isApprove ? "[ ACTION / APPROVE ]" : "[ ACTION / REJECT ]";
    document.querySelector("#approvalAction").classList.toggle("is-reject", !isApprove);
    document.querySelector("#approvalTitle").textContent = isApprove ? "确认批准此申请" : "确认拒绝此申请";
    document.querySelector("#approvalRequestId").textContent = approval.requestId;
    document.querySelector("#approvalApplicant").textContent = approval.applicantName;
    document.querySelector("#approvalDepartment").textContent = approval.departmentName;
    document.querySelector("#approvalTarget").textContent = approval.targetName;
    document.querySelector("#approvalValue").textContent = approval.value;
    document.querySelector("#approvalPurpose").textContent = approval.purpose;
    document.querySelector("#approvalApprover").textContent = approval.approverName;
    document.querySelector("#approvalExpires").textContent = new Date(approval.expiresAt).toLocaleString("zh-CN");
    document.querySelector("#approvalConfirmText").textContent = isApprove ? "确认批准并执行" : "确认拒绝申请";
    document.querySelector("#approvalConfirm").classList.toggle("is-reject", !isApprove);
    loading.hidden = true;
    content.hidden = false;
  }

  async function loadApproval() {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      showResult("审批链接无效", "链接不完整、已被修改或缺少审批 Token。请从原始邮件重新打开。");
      return;
    }
    try {
      const payload = await request("/api/email-approvals/preview", { token });
      approval = payload.approval;
      renderApproval();
    } catch (error) {
      showResult("无法使用此审批链接", error.message);
    }
  }

  document.querySelector("#approvalConfirm").addEventListener("click", async () => {
    if (!approval || !token) return;
    const button = document.querySelector("#approvalConfirm");
    button.disabled = true;
    status.textContent = "PROCESSING / 正在执行审批...";
    try {
      const payload = await request("/api/email-approvals/confirm", { token, reviewNote: document.querySelector("#approvalNote").value });
      token = "";
      showResult(payload.request.status === "approved" ? "申请已批准" : "申请已拒绝", `申请 ${payload.request.id} 已由 ${payload.request.reviewedBy} 通过邮件确认处理。`, true);
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });

  loadApproval();
})();
