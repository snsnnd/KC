export async function initDesktopExperience() {
  const stage = document.querySelector("#webglStage");
  const sections = [...document.querySelectorAll("main > section")];
  if (!stage || !window.WebGLRenderingContext) return () => {};

  const THREE = await import("../vendor/three.module.min.js");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0.1, 9);

  const devicePixelRatio = window.devicePixelRatio || 1;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: devicePixelRatio <= 1, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.82;
  stage.replaceChildren(renderer.domElement);

  const model = new THREE.Group();
  model.position.set(2.55, -0.15, 0);
  scene.add(model);

  const metal = new THREE.MeshStandardMaterial({ color: 0x1a1a20, metalness: 0.9, roughness: 0.3 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x0b0b0f, metalness: 0.76, roughness: 0.42 });
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x62626c, transparent: true, opacity: 0.48 });
  const activeMaterial = new THREE.MeshBasicMaterial({ color: 0xb8ff3d });

  function addInstrumentPart(geometry, material = metal) {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, material);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 24), edgeMaterial);
    group.add(mesh, edges);
    return group;
  }

  const base = addInstrumentPart(new THREE.CylinderGeometry(1.08, 1.28, 0.48, 32), darkMetal);
  base.position.y = -2.05;
  model.add(base);

  const turret = addInstrumentPart(new THREE.CylinderGeometry(0.72, 0.9, 0.72, 24));
  turret.position.y = -1.52;
  model.add(turret);

  const shoulderPivot = new THREE.Group();
  shoulderPivot.position.set(0, -1.25, 0);
  shoulderPivot.rotation.z = -0.55;
  model.add(shoulderPivot);

  const shoulder = addInstrumentPart(new THREE.CylinderGeometry(0.58, 0.58, 0.72, 24));
  shoulder.rotation.x = Math.PI / 2;
  shoulderPivot.add(shoulder);

  const lowerArm = addInstrumentPart(new THREE.BoxGeometry(0.58, 2.45, 0.56));
  lowerArm.position.y = 1.34;
  shoulderPivot.add(lowerArm);

  const elbowPivot = new THREE.Group();
  elbowPivot.position.y = 2.62;
  elbowPivot.rotation.z = 1.03;
  shoulderPivot.add(elbowPivot);

  const elbow = addInstrumentPart(new THREE.CylinderGeometry(0.52, 0.52, 0.68, 24));
  elbow.rotation.x = Math.PI / 2;
  elbowPivot.add(elbow);

  const upperArm = addInstrumentPart(new THREE.BoxGeometry(0.48, 2.1, 0.48));
  upperArm.position.y = 1.17;
  elbowPivot.add(upperArm);

  const wrist = addInstrumentPart(new THREE.CylinderGeometry(0.38, 0.45, 0.82, 20));
  wrist.position.y = 2.35;
  elbowPivot.add(wrist);

  const sensor = addInstrumentPart(new THREE.BoxGeometry(0.92, 0.5, 0.82), darkMetal);
  sensor.position.set(0, 2.88, 0);
  elbowPivot.add(sensor);

  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 20), activeMaterial);
  lens.position.set(0, 2.88, 0.45);
  lens.rotation.x = Math.PI / 2;
  elbowPivot.add(lens);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(3.35, 0.008, 4, 128),
    new THREE.MeshBasicMaterial({ color: 0x5b8cff, transparent: true, opacity: 0.22 })
  );
  ring.rotation.x = Math.PI / 2.8;
  model.add(ring);

  const pointCount = 900;
  const pointPositions = new Float32Array(pointCount * 3);
  for (let index = 0; index < pointCount; index += 1) {
    pointPositions[index * 3] = (Math.random() - 0.5) * 13;
    pointPositions[index * 3 + 1] = (Math.random() - 0.5) * 8;
    pointPositions[index * 3 + 2] = (Math.random() - 0.5) * 5 - 2;
  }
  const pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setAttribute("position", new THREE.BufferAttribute(pointPositions, 3));
  const points = new THREE.Points(pointGeometry, new THREE.PointsMaterial({ color: 0x73737e, size: 0.012, transparent: true, opacity: 0.36 }));
  scene.add(points);

  scene.add(new THREE.HemisphereLight(0x7184a8, 0x08080a, 1.5));
  const keyLight = new THREE.DirectionalLight(0xdde8ff, 3.2);
  keyLight.position.set(3, 4, 6);
  scene.add(keyLight);
  const rimLight = new THREE.PointLight(0xb8ff3d, 16, 7, 2);
  rimLight.position.set(2.5, 0.6, 2.8);
  scene.add(rimLight);
  const blueLight = new THREE.PointLight(0x5b8cff, 20, 8, 2);
  blueLight.position.set(-2.5, 1.5, -1);
  scene.add(blueLight);

  document.documentElement.classList.add("has-webgl");
  document.documentElement.classList.add("has-system-cursor");
  requestAnimationFrame(() => stage.classList.add("is-ready"));

  const cursor = document.createElement("div");
  cursor.className = "system-cursor";
  document.body.appendChild(cursor);
  let pointerX = window.innerWidth / 2;
  let pointerY = window.innerHeight / 2;
  let cursorX = pointerX;
  let cursorY = pointerY;
  let magneticTarget = null;
  const tiltBindings = [];

  function onPointerMove(event) {
    pointerX = event.clientX;
    pointerY = event.clientY;
    magneticTarget = event.target.closest("a, button, input, textarea, select");
    cursor.classList.toggle("is-magnetic", Boolean(magneticTarget));
  }

  function bindTilt(card) {
    const move = (event) => {
      if (!card.classList.contains("is-active")) return;
      const bounds = card.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - 0.5;
      const y = (event.clientY - bounds.top) / bounds.height - 0.5;
      card.style.setProperty("--tilt-x", `${(-y * 4).toFixed(2)}deg`);
      card.style.setProperty("--tilt-y", `${(x * 4).toFixed(2)}deg`);
      card.style.setProperty("--hud-x", `${(-x * 10).toFixed(1)}px`);
      card.style.setProperty("--hud-y", `${(-y * 10).toFixed(1)}px`);
    };
    const leave = () => {
      card.style.setProperty("--tilt-x", "0deg");
      card.style.setProperty("--tilt-y", "0deg");
      card.style.setProperty("--hud-x", "0px");
      card.style.setProperty("--hud-y", "0px");
    };
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerleave", leave);
    tiltBindings.push({ card, move, leave });
  }
  document.querySelectorAll(".project-card").forEach(bindTilt);

  const sceneStates = [
    { x: 2.55, y: -0.15, scale: 1, rx: 0.05, ry: -0.35 },
    { x: 3.25, y: 0.3, scale: 0.82, rx: -0.12, ry: 0.45 },
    { x: 2.85, y: -0.05, scale: 0.92, rx: 0.18, ry: 1.2 },
    { x: 3.45, y: 0.1, scale: 0.75, rx: -0.18, ry: 2.05 },
    { x: 2.7, y: -0.3, scale: 0.86, rx: 0.16, ry: 2.7 },
    { x: 0, y: -0.65, scale: 1.08, rx: -0.08, ry: 3.3 }
  ];

  let frame = 0;
  let running = true;
  let currentSection = 0;
  let wheelLocked = false;
  let wheelIntent = 0;
  let wheelResetTimer = 0;
  const targetScale = new THREE.Vector3(1, 1, 1);

  function nearestSectionIndex() {
    let nearest = 0;
    let distance = Infinity;
    sections.forEach((section, index) => {
      const nextDistance = Math.abs(section.getBoundingClientRect().top);
      if (nextDistance < distance) {
        distance = nextDistance;
        nearest = index;
      }
    });
    return nearest;
  }

  function onWheel(event) {
    const projectTrack = event.target.closest?.(".project-list");
    if (projectTrack && Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    if (wheelLocked) return;

    wheelIntent += event.deltaY;
    window.clearTimeout(wheelResetTimer);
    wheelResetTimer = window.setTimeout(() => { wheelIntent = 0; }, 120);
    if (Math.abs(wheelIntent) < 26) return;

    currentSection = nearestSectionIndex();
    const nextSection = Math.max(0, Math.min(currentSection + Math.sign(wheelIntent), sections.length - 1));
    wheelIntent = 0;
    if (nextSection === currentSection) return;
    wheelLocked = true;
    currentSection = nextSection;
    sections[currentSection].scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => { wheelLocked = false; }, 760);
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  function render(time) {
    if (!running) return;
    const progress = Math.max(0, Math.min(window.scrollY / Math.max(window.innerHeight, 1), sceneStates.length - 1));
    const stateIndex = Math.round(progress);
    const state = sceneStates[stateIndex] || sceneStates[0];
    const damping = 0.055;
    model.position.x += (state.x - model.position.x) * damping;
    model.position.y += (state.y - model.position.y) * damping;
    targetScale.setScalar(state.scale);
    model.scale.lerp(targetScale, damping);
    model.rotation.x += (state.rx - model.rotation.x) * damping;
    model.rotation.y += (state.ry - model.rotation.y) * damping;
    shoulderPivot.rotation.y = Math.sin(time * 0.00032) * 0.08;
    elbowPivot.rotation.x = Math.sin(time * 0.00024) * 0.06;
    ring.rotation.z += 0.0007;
    points.rotation.y -= 0.00008;
    let targetX = pointerX;
    let targetY = pointerY;
    if (magneticTarget) {
      const bounds = magneticTarget.getBoundingClientRect();
      targetX = bounds.left + bounds.width / 2;
      targetY = bounds.top + bounds.height / 2;
      cursor.style.width = `${Math.min(bounds.width + 14, 140)}px`;
      cursor.style.height = `${Math.min(bounds.height + 14, 70)}px`;
    } else {
      cursor.style.width = "18px";
      cursor.style.height = "18px";
    }
    cursorX += (targetX - cursorX) * 0.22;
    cursorY += (targetY - cursorY) * 0.22;
    cursor.style.left = `${cursorX}px`;
    cursor.style.top = `${cursorY}px`;
    renderer.render(scene, camera);
    frame = requestAnimationFrame(render);
  }

  function onVisibilityChange() {
    running = !document.hidden;
    if (running) frame = requestAnimationFrame(render);
  }

  window.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("resize", onResize, { passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  frame = requestAnimationFrame(render);

  return () => {
    running = false;
    cancelAnimationFrame(frame);
    window.clearTimeout(wheelResetTimer);
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    scene.traverse((object) => {
      object.geometry?.dispose();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material?.dispose();
    });
    renderer.dispose();
    stage.replaceChildren();
    stage.classList.remove("is-ready");
    document.documentElement.classList.remove("has-webgl");
    document.documentElement.classList.remove("has-system-cursor");
    tiltBindings.forEach(({ card, move, leave }) => { card.removeEventListener("pointermove", move); card.removeEventListener("pointerleave", leave); });
    cursor.remove();
  };
}
