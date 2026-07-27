function text(selector, value) {
  const node = document.querySelector(selector);
  if (node) node.textContent = String(value);
}

async function hydrateEvidence() {
  try {
    const response = await fetch("/data/status.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const status = await response.json();
    text("[data-clean-steps]", status.verification.steps);
    text("[data-adapters]", status.adapterSmoke.adapters);
    text("[data-public-runs]", status.publicEvidence.publishableComparisons);
    text("[data-clean-copy]", status.verification.copy);
    text("[data-public-copy]", status.publicEvidence.copy);
    text("[data-release-state]", status.release.label);
    document.querySelector("[data-status-dot]")?.classList.toggle("ok", status.release.code === "verified-pre-release");
  } catch {
    text("[data-release-state]", "Evidence file unavailable");
    text("[data-clean-copy]", "The repository remains the source of truth; this deployment could not load its generated status artifact.");
  }
}

hydrateEvidence();

function initProtocolScroll() {
  const section = document.querySelector("[data-protocol]");
  if (!section || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const steps = [...section.querySelectorAll("[data-protocol-step]")];
  const images = [...section.querySelectorAll("[data-protocol-image]")];
  const label = section.querySelector("[data-protocol-label]");
  const state = section.querySelector("[data-protocol-state]");
  const progressBar = section.querySelector("[data-protocol-progress]");
  const labels = ["T1 / Control", "T2 / Reference", "T3 / Composition", "T4 / Isolated"];
  const states = [
    "Capture off · Memory off",
    "Capture on · Memory off",
    "Capture on · Memory on",
    "Capture off · Memory on",
  ];
  let activeIndex = -1;
  let ticking = false;

  function render() {
    ticking = false;
    if (window.innerWidth <= 850) {
      section.style.setProperty("--protocol-progress", "0");
      return;
    }

    const rect = section.getBoundingClientRect();
    const stickyOffset = 66;
    const travel = Math.max(1, rect.height - window.innerHeight + stickyOffset);
    const progress = Math.min(1, Math.max(0, (stickyOffset - rect.top) / travel));
    const nextIndex = Math.min(steps.length - 1, Math.floor(progress * steps.length));
    section.style.setProperty("--protocol-progress", progress.toFixed(4));
    if (progressBar) progressBar.style.width = `${(progress * 100).toFixed(2)}%`;

    if (nextIndex !== activeIndex) {
      activeIndex = nextIndex;
      steps.forEach((step, index) => step.classList.toggle("is-active", index === activeIndex));
      images.forEach((image, index) => image.classList.toggle("is-active", index === activeIndex));
      if (label) label.textContent = labels[activeIndex];
      if (state) state.textContent = states[activeIndex];
    }
  }

  function requestRender() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(render);
  }

  addEventListener("scroll", requestRender, { passive: true });
  addEventListener("resize", requestRender);
  render();
}

initProtocolScroll();

function initInstrumentScroll() {
  const section = document.querySelector("[data-instrument]");
  if (!section || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const notes = [...section.querySelectorAll("[data-instrument-note]")];
  let activeIndex = -1;
  let ticking = false;

  function render() {
    ticking = false;
    if (window.innerWidth <= 850) return;

    const rect = section.getBoundingClientRect();
    const stickyOffset = 66;
    const travel = Math.max(1, rect.height - window.innerHeight + stickyOffset);
    const progress = Math.min(1, Math.max(0, (stickyOffset - rect.top) / travel));
    const nextIndex = Math.min(notes.length - 1, Math.floor(progress * notes.length));
    section.style.setProperty("--instrument-progress", progress.toFixed(4));

    if (nextIndex !== activeIndex) {
      activeIndex = nextIndex;
      notes.forEach((note, index) => note.classList.toggle("is-active", index === activeIndex));
    }
  }

  function requestRender() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(render);
  }

  addEventListener("scroll", requestRender, { passive: true });
  addEventListener("resize", requestRender);
  render();
}

initInstrumentScroll();
