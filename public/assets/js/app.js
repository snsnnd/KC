(async function () {
  "use strict";

  if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

  function resetPresentationPosition() {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const main = document.querySelector("main");
    if (main) main.scrollTop = 0;
  }

  if (window.location.hash) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  resetPresentationPosition();
  window.addEventListener("pageshow", () => window.requestAnimationFrame(resetPresentationPosition));

  document.body.classList.add("is-booting");

  let data = window.SITE_DATA || { projects: [] };
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 900);
    const response = await fetch("/api/content", { cache: "no-store", signal: controller.signal });
    window.clearTimeout(timeout);
    if (response.ok) data = await response.json();
  } catch {
    // The static data remains a complete fallback when the CMS is unavailable.
  }

  if (data.settings) {
    document.querySelectorAll(".brand strong").forEach((element) => { element.textContent = data.settings.englishName || "TECH SYNERGY"; });
    document.querySelectorAll(".brand small").forEach((element) => { element.textContent = data.settings.clubName || "科技创新社"; });
    const mission = document.querySelector(".hero__bottom p");
    if (mission && data.settings.heroDescription) mission.lastChild.textContent = data.settings.heroDescription;
    const title = data.settings.heroTitle?.trim();
    if (title) {
      const titleParts = document.querySelectorAll(".title-line > span");
      const breakpoint = Math.max(2, Math.min(title.length - 2, Math.round(title.length / 2)));
      titleParts[0].textContent = title.slice(0, breakpoint);
      titleParts[1].textContent = title.slice(breakpoint);
      document.querySelector(".hero__title").setAttribute("aria-label", title);
    }
  }
  const projectList = document.querySelector("#projectList");
  const template = document.querySelector("#projectTemplate");
  const videos = [];
  const projects = Array.isArray(data.projects) ? data.projects : [];

  projects.forEach((project, index) => {
    const fragment = template.content.cloneNode(true);
    const card = fragment.querySelector(".project-card");
    const video = fragment.querySelector("video");
    const category = project.category || project.tags?.[0] || "未分类";
    card.style.setProperty("--project-color", project.color || "#b8ff3d");
    card.dataset.category = category;
    card.dataset.search = [project.id, project.title, category, project.description, ...(project.tags || [])].join(" ").toLocaleLowerCase("zh-CN");
    fragment.querySelector(".project-card__number").textContent = String(index + 1).padStart(2, "0");
    fragment.querySelector(".media-id").textContent = project.id;
    fragment.querySelector(".media-category").textContent = category;
    fragment.querySelector(".project-card__category").textContent = `CATEGORY / ${category}`;
    fragment.querySelector("h3").textContent = project.title;
    fragment.querySelector("p").textContent = project.description;

    const tags = fragment.querySelector(".project-card__tags");
    (project.tags || []).forEach((tag) => {
      const item = document.createElement("span");
      item.textContent = `[ ${tag} ]`;
      tags.appendChild(item);
    });

    if (project.video) {
      card.classList.add("has-video");
      video.dataset.src = project.video;
      if (project.poster) {
        video.poster = project.poster;
        card.classList.add("has-poster");
      }
      video.addEventListener("loadeddata", () => card.classList.add("is-video-ready"), { once: true });
      fragment.querySelector(".media-state").lastChild.textContent = " LIVE CAPTURE";
      videos.push({ video, card });
    }

    const links = fragment.querySelector(".project-card__links");
    (project.links || []).forEach((link) => {
      const anchor = document.createElement("a");
      anchor.textContent = link.label;
      const arrow = document.createElement("span");
      arrow.textContent = "↗";
      anchor.appendChild(arrow);
      if (link.url) {
        anchor.href = link.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      } else {
        anchor.href = "#";
        anchor.classList.add("is-disabled");
        anchor.title = "链接待接入";
        anchor.addEventListener("click", (event) => event.preventDefault());
      }
      links.appendChild(anchor);
    });

    const playButton = fragment.querySelector(".play-control");
    playButton.addEventListener("click", () => {
      if (!video.src) {
        video.src = video.dataset.src;
        video.load();
      }
      if (video.paused) {
        video.play().then(() => {
          card.classList.remove("is-fallback");
          setVideoControl(playButton, true);
        }).catch(() => {
          card.classList.add("is-fallback");
          setVideoControl(playButton, false);
        });
      } else {
        video.pause();
        setVideoControl(playButton, false);
      }
    });

    projectList.appendChild(fragment);
  });

  const projectCards = [...projectList.querySelectorAll(".project-card")];
  const projectCount = document.querySelector("#projectCount");
  const projectPrev = document.querySelector("#projectPrev");
  const projectNext = document.querySelector("#projectNext");
  const projectSearch = document.querySelector("#projectSearch");
  const projectCategories = document.querySelector("#projectCategories");
  const projectResults = document.querySelector("#projectResults");
  const projectEmpty = document.querySelector("#projectEmpty");
  let visibleProjectCards = [...projectCards];
  let activeCategory = "全部";
  let activeProject = 0;

  function updateProjectCounter(index) {
    if (!visibleProjectCards.length) {
      activeProject = 0;
      projectCount.textContent = "00 / 00";
      projectPrev.disabled = true;
      projectNext.disabled = true;
      projectCards.forEach((card) => card.classList.remove("is-active"));
      return;
    }
    activeProject = Math.max(0, Math.min(index, visibleProjectCards.length - 1));
    projectCount.textContent = `${String(activeProject + 1).padStart(2, "0")} / ${String(visibleProjectCards.length).padStart(2, "0")}`;
    projectPrev.disabled = activeProject === 0;
    projectNext.disabled = activeProject === visibleProjectCards.length - 1;
    projectCards.forEach((card) => {
      const isActive = visibleProjectCards[activeProject] === card;
      card.classList.toggle("is-active", isActive);
      card.setAttribute("aria-current", isActive ? "true" : "false");
    });
  }

  function showProject(index) {
    const target = visibleProjectCards[Math.max(0, Math.min(index, visibleProjectCards.length - 1))];
    if (!target) return;
    updateProjectCounter(visibleProjectCards.indexOf(target));
    const trackRect = projectList.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetLeft = projectList.scrollLeft + targetRect.left - trackRect.left;
    projectList.scrollTo({ left: targetLeft, behavior: "smooth" });
  }

  projectPrev.addEventListener("click", () => showProject(activeProject - 1));
  projectNext.addEventListener("click", () => showProject(activeProject + 1));

  const projectObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting && !entry.target.hidden).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible) updateProjectCounter(visibleProjectCards.indexOf(visible.target));
  }, { root: projectList, threshold: [0.55, 0.8] });
  projectCards.forEach((card) => projectObserver.observe(card));

  const categories = ["全部", ...new Set(projectCards.map((card) => card.dataset.category))];
  categories.forEach((category) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = category;
    button.classList.toggle("is-active", category === activeCategory);
    button.addEventListener("click", () => {
      activeCategory = category;
      [...projectCategories.children].forEach((item) => item.classList.toggle("is-active", item === button));
      applyProjectFilters();
    });
    projectCategories.appendChild(button);
  });

  function applyProjectFilters() {
    const query = projectSearch.value.trim().toLocaleLowerCase("zh-CN");
    visibleProjectCards = projectCards.filter((card) => {
      const matchesCategory = activeCategory === "全部" || card.dataset.category === activeCategory;
      const matchesQuery = !query || card.dataset.search.includes(query);
      card.hidden = !matchesCategory || !matchesQuery;
      if (card.hidden) card.querySelector("video")?.pause();
      return !card.hidden;
    });
    projectResults.textContent = `${String(visibleProjectCards.length).padStart(2, "0")} / ${String(projectCards.length).padStart(2, "0")} SYSTEMS`;
    projectEmpty.hidden = visibleProjectCards.length > 0;
    projectList.hidden = visibleProjectCards.length === 0;
    updateProjectCounter(0);
    if (visibleProjectCards[0]) projectList.scrollTo({ left: visibleProjectCards[0].offsetLeft, behavior: "auto" });
  }

  projectSearch.addEventListener("input", applyProjectFilters);
  applyProjectFilters();

  function setVideoControl(button, isPlaying) {
    button.querySelector("span").textContent = isPlaying ? "Ⅱ" : "▶";
    button.setAttribute("aria-label", isPlaying ? "暂停项目视频" : "播放项目视频");
  }

  const videoObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const video = entry.target;
      const button = video.closest(".project-card").querySelector(".play-control");
      if (entry.isIntersecting) {
        if (!video.src) {
          video.src = video.dataset.src;
          video.load();
        }
        video.play().then(() => {
          video.closest(".project-card").classList.remove("is-fallback");
          setVideoControl(button, true);
        }).catch(() => {
          video.closest(".project-card").classList.add("is-fallback");
          setVideoControl(button, false);
        });
      } else {
        video.pause();
        setVideoControl(button, false);
      }
    });
  }, { rootMargin: "120px 0px", threshold: 0.15 });
  videos.forEach(({ video }) => videoObserver.observe(video));

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const bootScreen = document.querySelector(".boot-screen");
  const bootValue = document.querySelector("#bootValue");
  const bootBar = document.querySelector("#bootBar");
  const bootStatus = document.querySelector("#bootStatus");
  const enterSite = document.querySelector("#enterSite");
  const statuses = ["INITIALIZING CORE MODULES", "CHECKING SENSOR ARRAY", "SYNCING HARDWARE LAYER", "SYSTEM READY"];
  let hasBooted = false;
  try { hasBooted = window.sessionStorage.getItem("hasBooted") === "true"; } catch {}
  const bootDuration = reducedMotion ? 50 : (hasBooted ? 320 : 1500);
  const bootStart = performance.now();
  let lastStatusIndex = -1;

  function runBoot(now) {
    const progress = Math.min((now - bootStart) / bootDuration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.floor(eased * 100);
    bootValue.textContent = String(value).padStart(3, "0");
    bootBar.style.transform = `scaleX(${eased})`;
    const statusIndex = Math.min(Math.floor(progress * statuses.length), statuses.length - 1);
    if (statusIndex !== lastStatusIndex) {
      bootStatus.textContent = statuses[statusIndex];
      lastStatusIndex = statusIndex;
    }
    if (progress < 1) {
      requestAnimationFrame(runBoot);
    } else {
      bootScreen.classList.add("is-ready");
      bootStatus.textContent = "SYSTEM READY / AWAITING INPUT";
      enterSite.disabled = false;
      try { window.sessionStorage.setItem("hasBooted", "true"); } catch {}
    }
  }
  requestAnimationFrame(runBoot);

  enterSite.addEventListener("click", () => {
    if (enterSite.disabled) return;
    enterSite.disabled = true;
    bootScreen.classList.add("is-entering");
    window.setTimeout(() => {
      bootScreen.classList.add("is-complete");
      document.body.classList.remove("is-booting");
      revealVisibleItems();
      if (!reducedMotion) document.querySelectorAll(".title-line > span").forEach(scrambleText);
      syncDesktopExperience();
    }, reducedMotion ? 0 : 460);
  });

  const revealItems = [...document.querySelectorAll(".reveal")];
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting && !document.body.classList.contains("is-booting")) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -5%" });
  revealItems.forEach((item) => observer.observe(item));

  function revealVisibleItems() {
    revealItems.forEach((item) => {
      if (item.getBoundingClientRect().top < window.innerHeight * 0.95) item.classList.add("is-visible");
    });
  }

  function scrambleText(element) {
    const finalText = element.textContent;
    const glyphs = "01X#$%&@+<>";
    const startedAt = performance.now();
    function frame(now) {
      const progress = Math.min((now - startedAt) / 520, 1);
      const locked = Math.floor(progress * finalText.length);
      element.textContent = [...finalText].map((character, index) => index < locked || /\s/.test(character) ? character : glyphs[Math.floor(Math.random() * glyphs.length)]).join("");
      if (progress < 1) requestAnimationFrame(frame);
      else element.textContent = finalText;
    }
    requestAnimationFrame(frame);
  }

  const menuButton = document.querySelector(".menu-toggle");
  const header = document.querySelector(".site-header");
  menuButton.addEventListener("click", () => {
    const open = header.classList.toggle("is-open");
    menuButton.setAttribute("aria-expanded", String(open));
  });
  document.querySelectorAll(".site-header nav a").forEach((link) => link.addEventListener("click", () => {
    header.classList.remove("is-open");
    menuButton.setAttribute("aria-expanded", "false");
  }));

  document.querySelectorAll('a[href^="#"]:not([href="#"])').forEach((link) => {
    link.addEventListener("click", (event) => {
      const target = document.querySelector(link.getAttribute("href"));
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    });
  });

  const sections = [...document.querySelectorAll("main > section")];
  const sectionLinks = [...document.querySelectorAll(".page-rail a, .mobile-dock a")];
  const sectionObserver = new IntersectionObserver((entries) => {
    const active = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!active) return;
    sectionLinks.forEach((link) => link.classList.toggle("is-active", link.hash === `#${active.target.id}`));
  }, { threshold: [0.5, 0.72] });
  sections.forEach((section) => sectionObserver.observe(section));

  if (!reducedMotion) {
    const inputValue = document.querySelector("#inputValue");
    const latencyValue = document.querySelector("#latencyValue");
    window.setInterval(() => {
      window.requestAnimationFrame(() => {
        inputValue.textContent = (24 + Math.random() * .12).toFixed(2);
        latencyValue.textContent = String(6 + Math.floor(Math.random() * 5)).padStart(2, "0");
      });
    }, 1200);
  }

  document.querySelector("#year").textContent = new Date().getFullYear();

  const desktopExperience = window.matchMedia("(min-width: 1024px) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
  let stopDesktopExperience = null;

  async function syncDesktopExperience() {
    if (desktopExperience.matches && !stopDesktopExperience) {
      try {
        const module = await import("./desktop-experience.js?v=9");
        if (desktopExperience.matches) stopDesktopExperience = await module.initDesktopExperience();
      } catch (error) {
        console.warn("Desktop experience unavailable; using the CSS fallback.", error);
      }
    } else if (!desktopExperience.matches && stopDesktopExperience) {
      stopDesktopExperience();
      stopDesktopExperience = null;
    }
  }

  desktopExperience.addEventListener("change", syncDesktopExperience);
})();
