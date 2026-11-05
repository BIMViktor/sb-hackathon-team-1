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
  const paint = (step) => {
    if (!root.contains(list)) return;
    step.li.dataset.state = step.state;
    step.li.querySelector("small").textContent =
      step.state === "done" ? `${(step.ms / 1000).toFixed(1)} s` : step.state === "fail" ? "misslyckades" : "";
    const finished = steps.filter((s) => s.state !== "run").length;
    bar.style.width = `${Math.max(6, (finished / steps.length) * 100)}%`;
  };
  return {
    track(label, promise) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="dot"></span>${esc(label)}<small></small>`;
      list.append(li);
      const step = { li, state: "run", start: performance.now() };
      steps.push(step);
      paint(step);
      return Promise.resolve(promise).then(
        (value) => {
          step.state = "done";
          step.ms = performance.now() - step.start;
          paint(step);
          return value;
        },
        (error) => {
          step.state = "fail";
          paint(step);
          throw error;
        },
      );
    },
    title(text) {
      titleEl.textContent = text;
    },
  };
}
