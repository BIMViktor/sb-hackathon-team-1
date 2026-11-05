/** Small HTML helpers shared by the views. */

export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function option(value, label, selected = false) {
  return `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
}

/**
 * Loading view: a progress bar, one line per request (spinner → tick with its
 * time) and skeleton rows. `track(label, promise)` adds a line and returns the
 * promise. Lines stop updating once something else replaces the view.
 */
const STEP_MS = 220;

export function createLoader(root, title) {
  root.innerHTML = `
    <div class="loader" aria-live="polite">
      <div class="loader-bar"><span></span></div>
      <p class="loader-title">${esc(title)}</p>
      <ol class="loader-steps"></ol>
      <div class="skeleton" aria-hidden="true">${'<div class="sk-row"><i></i><span><b></b><b></b></span><em></em></div>'.repeat(6)}</div>
    </div>`;
  const list = root.querySelector(".loader-steps");
  const bar = root.querySelector(".loader-bar span");
  const titleEl = root.querySelector(".loader-title");
  const steps = [];
  // Steps are ticked off one at a time, STEP_MS apart, so fast ones can be read too.
  let queue = Promise.resolve();
  const paint = (step) => {
    if (!root.contains(list)) return;
    step.li.dataset.state = step.state;
    step.li.querySelector("small").textContent =
      step.state === "done" ? `${(step.ms / 1000).toFixed(1)} s` : step.state === "fail" ? "misslyckades" : "";
    const finished = steps.filter((s) => s.shown).length;
    bar.style.width = `${Math.max(6, (finished / steps.length) * 100)}%`;
  };
  const reveal = (step) => {
    queue = queue.then(() => {
      step.shown = true;
      paint(step);
      return new Promise((resolve) => setTimeout(resolve, STEP_MS));
    });
  };
  return {
    track(label, promise) {
      const li = document.createElement("li");
      li.dataset.state = "run";
      li.innerHTML = `<span class="dot"></span>${esc(label)}<small></small>`;
      list.append(li);
      const step = { li, state: "run", start: performance.now() };
      steps.push(step);
      paint(step);
      return Promise.resolve(promise).then(
        (value) => {
          step.state = "done";
          step.ms = performance.now() - step.start;
          reveal(step);
          return value;
        },
        (error) => {
          step.state = "fail";
          reveal(step);
          throw error;
        },
      );
    },
    /** Resolves once every step finished so far has been ticked off on screen. */
    idle() {
      return queue.then(() => new Promise((resolve) => setTimeout(resolve, STEP_MS)));
    },
    title(text) {
      titleEl.textContent = text;
    },
  };
}
