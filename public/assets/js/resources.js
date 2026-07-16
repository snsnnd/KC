(async function () {
  "use strict";
  const response = await fetch("/api/content", { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return showFailure();
  const content = await response.json();
  const page = document.body.dataset.page;

  function flatten(resources) {
    return resources.flatMap((resource) => [resource, ...flatten(resource.children || [])]);
  }

  function findResource(resources, id) {
    for (const resource of resources) {
      if (resource.id === id) return resource;
      const child = findResource(resource.children || [], id);
      if (child) return child;
    }
    return null;
  }

  function createResourceCard(resource, index = 0) {
    const link = document.createElement("a");
    link.className = `resource-card${resource.children?.length ? " is-collection" : ""}`;
    link.href = `/resource.html?id=${encodeURIComponent(resource.id)}`;
    const top = document.createElement("span");
    top.className = "resource-card__top";
    const type = document.createElement("span");
    type.textContent = resource.children?.length ? `[ COLLECTION / ${resource.children.length} ITEMS ]` : `[ ${resource.type || "RESOURCE"} ]`;
    const light = document.createElement("i");
    top.append(type, light);
    const title = document.createElement("h2");
    title.textContent = resource.title;
    const description = document.createElement("p");
    description.textContent = resource.description;
    const action = document.createElement("span");
    action.textContent = `${String(index + 1).padStart(2, "0")} / ${resource.children?.length ? "VIEW COLLECTION" : "VIEW ENDPOINT"} →`;
    link.append(top, title, description, action);
    return link;
  }

  if (page === "resources") {
    const list = document.querySelector("#resourceList");
    document.querySelector("#resourceCount").textContent = `${String(flatten(content.resources).length).padStart(2, "0")} NODES`;
    list.replaceChildren();
    content.resources.forEach((resource, index) => list.appendChild(createResourceCard(resource, index)));
    if (!content.resources.length) list.textContent = "NO RESOURCES AVAILABLE";
  } else {
    const id = new URLSearchParams(window.location.search).get("id");
    const resource = findResource(content.resources, id);
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
    const actions = document.createElement("div");
    actions.className = "resource-endpoints";
    if (resource.protected) {
      const external = document.createElement("a");
      external.className = "external-button";
      external.textContent = "MEMBER LOGIN REQUIRED →";
      external.href = `/portal.html?type=member&next=${encodeURIComponent(`/member.html?resource=${resource.id}`)}`;
      actions.appendChild(external);
    } else {
      const endpoints = [...(resource.url ? [{ label: "主链接", url: resource.url }] : []), ...(resource.links || []).filter((link) => link.url)];
      endpoints.forEach((endpoint) => {
        const external = document.createElement("a");
        external.className = "external-button";
        external.textContent = `${endpoint.label || "打开资源"} ↗`;
        external.href = endpoint.url;
        external.target = "_blank";
        external.rel = "noopener noreferrer nofollow";
        actions.appendChild(external);
      });
      if (!endpoints.length && !resource.children?.length) {
        const external = document.createElement("a");
        external.className = "external-button";
        external.textContent = "ENDPOINT NOT CONFIGURED";
        external.setAttribute("aria-disabled", "true");
        actions.appendChild(external);
      }
    }
    detail.append(type, title, description, note, actions);
    if (resource.children?.length) {
      const collectionTitle = document.createElement("h2");
      collectionTitle.className = "resource-collection-title";
      collectionTitle.textContent = "合集内容";
      const children = document.createElement("div");
      children.className = "resource-child-grid";
      resource.children.forEach((child, index) => children.appendChild(createResourceCard(child, index)));
      detail.append(collectionTitle, children);
    }
  }

  function showFailure() {
    const target = document.querySelector("#resourceList, #resourceDetail");
    if (target) target.textContent = "REGISTRY OFFLINE / 资源服务暂不可用";
  }
})();
