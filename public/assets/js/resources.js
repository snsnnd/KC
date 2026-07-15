(async function () {
  "use strict";
  const response = await fetch("/api/content", { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return showFailure();
  const content = await response.json();
  const page = document.body.dataset.page;

  if (page === "resources") {
    const list = document.querySelector("#resourceList");
    document.querySelector("#resourceCount").textContent = `${String(content.resources.length).padStart(2, "0")} NODES`;
    list.replaceChildren();
    content.resources.forEach((resource, index) => {
      const link = document.createElement("a");
      link.className = "resource-card";
      link.href = `/resource.html?id=${encodeURIComponent(resource.id)}`;
      const top = document.createElement("span");
      top.className = "resource-card__top";
      const type = document.createElement("span");
      type.textContent = `[ ${resource.type || "RESOURCE"} ]`;
      const light = document.createElement("i");
      top.append(type, light);
      const title = document.createElement("h2");
      title.textContent = resource.title;
      const description = document.createElement("p");
      description.textContent = resource.description;
      const action = document.createElement("span");
      action.textContent = `${String(index + 1).padStart(2, "0")} / VIEW ENDPOINT →`;
      link.append(top, title, description, action);
      list.appendChild(link);
    });
    if (!content.resources.length) list.textContent = "NO RESOURCES AVAILABLE";
  } else {
    const id = new URLSearchParams(window.location.search).get("id");
    const resource = content.resources.find((item) => item.id === id);
    const detail = document.querySelector("#resourceDetail");
    detail.replaceChildren();
    if (!resource) {
      detail.textContent = "RESOURCE NOT FOUND / 资源不存在";
      return;
    }
    const type = document.createElement("span");
    type.className = "sub-kicker";
    type.textContent = `[ ${resource.type || "EXTERNAL RESOURCE"} ]`;
    const title = document.createElement("h1");
    title.textContent = resource.title;
    const description = document.createElement("p");
    description.textContent = resource.description;
    const note = document.createElement("div");
    note.className = "access-note";
    note.textContent = resource.accessNote || "即将离开本站，请确认目标地址可信。";
    const external = document.createElement("a");
    external.className = "external-button";
    external.textContent = resource.protected ? "MEMBER LOGIN REQUIRED →" : resource.url ? "CONFIRM & OPEN EXTERNAL RESOURCE ↗" : "ENDPOINT NOT CONFIGURED";
    if (resource.protected) {
      external.href = `/portal.html?type=member&next=${encodeURIComponent(`/member.html?resource=${resource.id}`)}`;
    } else if (resource.url) {
      external.href = resource.url;
      external.target = "_blank";
      external.rel = "noopener noreferrer nofollow";
    } else {
      external.setAttribute("aria-disabled", "true");
    }
    detail.append(type, title, description, note, external);
  }

  function showFailure() {
    const target = document.querySelector("#resourceList, #resourceDetail");
    if (target) target.textContent = "REGISTRY OFFLINE / 资源服务暂不可用";
  }
})();
