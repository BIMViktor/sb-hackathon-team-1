/**
 * Group × project view: pick a group name and some projects, then tick which
 * users belong to that group in each project. Missing groups are created and
 * users who are not in a project are added (as Användare) first.
 */

import { WRITE_GAP_MS, addMemberOp, addToGroupOp, createGroupOp, loadProject, removeFromGroupOp } from "./data.js";
import { esc } from "./ui.js";

const MAX_PROJECTS = 15;
const NEW_MEMBER_LEVEL = 10;

export function createMatrix({ root, rest, projects, currentProjectId, showPreview, log }) {
  const state = {
    picked: new Set([currentProjectId]),
    loaded: new Map(),
    groupName: "",
    shown: [],
    changes: new Map(),
    filter: "",
  };

  root.innerHTML = `
    <div class="mx-controls">
      <label class="mx-field">Grupp
        <input id="mx-group" list="mx-groups" placeholder="t.ex. @Projektering_El" autocomplete="off" />
      </label>
      <details id="mx-picker" class="mx-picker">
        <summary id="mx-picked">Projekt</summary>
        <div class="mx-picker-body">
          <input id="mx-psearch" type="search" placeholder="Sök projekt…" />
          <div id="mx-plist" class="mx-plist"></div>
        </div>
      </details>
      <button id="mx-show" type="button" class="primary">Visa</button>
    </div>
    <datalist id="mx-groups"></datalist>
    <div id="mx-head" class="mx-head" hidden>
      <input id="mx-filter" type="search" placeholder="Filtrera användare…" />
      <span id="mx-legend" class="muted">☐ med i projektet · <span class="mx-out-dot"></span> inte med i projektet ännu</span>
    </div>
    <div id="mx-table" class="mx-wrap"><p class="empty">Välj en grupp och projekt, tryck Visa.</p></div>
    <div id="mx-bar" class="batch" hidden>
      <span id="mx-count" class="batch-count"></span>
      <button id="mx-preview" type="button" class="primary">Förhandsgranska</button>
      <button id="mx-reset" type="button" class="ghost">Ångra markeringar</button>
    </div>`;

  const $ = (selector) => root.querySelector(selector);
  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? `Projekt ${id}`;
  const findGroup = (data) => {
    const key = state.groupName.trim().toLowerCase();
    return data.groups.find((g) => g.name.toLowerCase() === key);
  };
  const keyOf = (pid, email) => `${pid}|${email}`;

  function original(pid, email) {
    const data = state.loaded.get(pid);
    const row = data?.rowByEmail.get(email);
    const group = data && findGroup(data);
    return Boolean(row && group && row.groups.has(group.id));
  }

  const wanted = (pid, email) => (state.changes.has(keyOf(pid, email)) ? state.changes.get(keyOf(pid, email)) : original(pid, email));

  function setWanted(pid, email, value) {
    const key = keyOf(pid, email);
    if (value === original(pid, email)) state.changes.delete(key);
    else state.changes.set(key, value);
  }

  /* ---------- project picker ---------- */

  function renderPicker() {
    const query = $("#mx-psearch").value.trim().toLowerCase();
    $("#mx-plist").innerHTML = projects
      .filter((p) => !p.inactive && (!query || p.name.toLowerCase().includes(query) || state.picked.has(p.id)))
      .map(
        (p) => `<label class="check"><input type="checkbox" value="${esc(p.id)}" ${state.picked.has(p.id) ? "checked" : ""} />
          ${esc(p.name)}${p.id === currentProjectId ? ` <span class="muted">(öppet)</span>` : ""}</label>`,
      )
      .join("");
    $("#mx-picked").textContent = `Projekt (${state.picked.size} valda)`;
  }

  $("#mx-psearch").addEventListener("input", renderPicker);
  $("#mx-plist").addEventListener("change", (event) => {
    const box = event.target;
    if (box.checked && state.picked.size >= MAX_PROJECTS) {
      box.checked = false;
      return log(`Högst ${MAX_PROJECTS} projekt åt gången.`, "error");
    }
    if (box.checked) state.picked.add(box.value);
    else state.picked.delete(box.value);
    $("#mx-picked").textContent = `Projekt (${state.picked.size} valda)`;
  });

  function renderGroupNames() {
    const names = new Set();
    for (const data of state.loaded.values()) for (const g of data.groups) if (!g.readOnly) names.add(g.name);
    $("#mx-groups").innerHTML = [...names]
      .sort((a, b) => a.localeCompare(b, "sv"))
      .map((name) => `<option value="${esc(name)}"></option>`)
      .join("");
  }

  /* ---------- loading ---------- */

  async function ensureLoaded(ids, force = false) {
    const todo = ids.filter((id) => force || !state.loaded.has(id));
    for (const [i, id] of todo.entries()) {
      log(`Läser ${projectName(id)} (${i + 1}/${todo.length})…`);
      try {
        state.loaded.set(id, await loadProject(rest, id));
      } catch {
        state.loaded.delete(id);
        log(`Kan inte läsa ${projectName(id)}. Du behöver vara projektadmin där.`, "error");
      }
      await new Promise((resolve) => setTimeout(resolve, WRITE_GAP_MS));
    }
    renderGroupNames();
  }

  async function show() {
    state.groupName = $("#mx-group").value.trim();
    if (!state.groupName) return log("Skriv eller välj en grupp.", "error");
    if (!state.picked.size) return log("Välj minst ett projekt.", "error");
    $("#mx-picker").open = false;
    state.changes.clear();
    await ensureLoaded([...state.picked]);
    state.shown = [...state.picked].filter((id) => state.loaded.has(id));
    log(`${state.groupName} i ${state.shown.length} projekt.`);
    render();
  }

  /* ---------- table ---------- */

  function people() {
    const byEmail = new Map();
    for (const id of state.shown) {
      for (const row of state.loaded.get(id).rows) if (!byEmail.has(row.email) || !byEmail.get(row.email).name) byEmail.set(row.email, row);
    }
    const query = state.filter.toLowerCase();
    return [...byEmail.values()]
      .filter((row) => !query || [row.name, row.email, row.organization].some((v) => v.toLowerCase().includes(query)))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, "sv"));
  }

  function render() {
    $("#mx-head").hidden = !state.shown.length;
    if (!state.shown.length) {
      $("#mx-table").innerHTML = `<p class="empty">Inga projekt kunde läsas.</p>`;
      return renderBar();
    }
    const rows = people();
    const head = state.shown
      .map((id) => {
        const data = state.loaded.get(id);
        const group = findGroup(data);
        const all = rows.length > 0 && rows.every((row) => wanted(id, row.email));
        return `<th data-pid="${esc(id)}">
          <span class="mx-pname" title="${esc(projectName(id))}">${esc(projectName(id))}</span>
          <span class="mx-state ${group ? "" : "new"}">${group ? `${count(id)} med` : "gruppen skapas"}</span>
          <label class="check mx-colall" title="Markera alla synliga"><input type="checkbox" data-col="${esc(id)}" ${all ? "checked" : ""} /> alla</label>
        </th>`;
      })
      .join("");
    const body = rows
      .map(
        (row) => `<tr>
          <th class="mx-user"><b>${esc(row.name || row.email)}</b><small>${esc(row.email)}</small></th>
          ${state.shown
            .map((id) => {
              const member = state.loaded.get(id).rowByEmail.has(row.email);
              const on = wanted(id, row.email);
              const changed = state.changes.has(keyOf(id, row.email));
              return `<td class="${member ? "" : "out"} ${changed ? "changed" : ""}">
                <input type="checkbox" data-pid="${esc(id)}" data-email="${esc(row.email)}" ${on ? "checked" : ""}
                  title="${esc(member ? projectName(id) : `${projectName(id)}: läggs till i projektet`)}" />
              </td>`;
            })
            .join("")}
        </tr>`,
      )
      .join("");
    $("#mx-table").innerHTML = rows.length
      ? `<table class="mx"><thead><tr><th class="mx-user">${rows.length} användare</th>${head}</tr></thead><tbody>${body}</tbody></table>`
      : `<p class="empty">Inga användare matchar.</p>`;
    renderBar();
  }

  function count(id) {
    const data = state.loaded.get(id);
    const group = findGroup(data);
    return group ? data.rows.filter((row) => row.groups.has(group.id)).length : 0;
  }

  function renderBar() {
    const n = state.changes.size;
    $("#mx-bar").hidden = n === 0;
    $("#mx-count").textContent = `${n} ändrade rutor`;
  }

  $("#mx-table").addEventListener("change", (event) => {
    const box = event.target;
    if (box.dataset.col) {
      for (const row of people()) setWanted(box.dataset.col, row.email, box.checked);
      return render();
    }
    if (!box.dataset.pid) return;
    setWanted(box.dataset.pid, box.dataset.email, box.checked);
    box.closest("td").classList.toggle("changed", state.changes.has(keyOf(box.dataset.pid, box.dataset.email)));
    renderBar();
  });

  $("#mx-filter").addEventListener("input", (event) => {
    state.filter = event.target.value.trim();
    render();
  });

  /* ---------- operations ---------- */

  function buildOps() {
    const ops = [];
    const skipped = [];
    const lookup = new Map(people().map((row) => [row.email, row]));
    for (const id of state.shown) {
      const data = state.loaded.get(id);
      const changes = [...state.changes].filter(([key]) => key.startsWith(`${id}|`)).map(([key, on]) => [key.slice(id.length + 1), on]);
      if (!changes.length) continue;
      const existing = findGroup(data);
      const group = existing ? { ...existing } : { id: null, name: state.groupName };
      if (!existing && changes.some(([, on]) => on)) ops.push(createGroupOp(id, projectName(id), group));
      for (const [email, on] of changes) {
        const row = data.rowByEmail.get(email);
        if (on) {
          if (!row) {
            const source = lookup.get(email) ?? { given: "", family: "", organization: "", title: "", orgId: null };
            ops.push(
              addMemberOp(
                id,
                email,
                {
                  "privilege-level": NEW_MEMBER_LEVEL,
                  guest: false,
                  "given-name": source.given,
                  "family-name": source.family,
                  organization: source.organization,
                  title: source.title,
                },
                source.orgId ?? undefined,
                `Lägg till i ${projectName(id)} som Användare`,
              ),
            );
          }
          const op = addToGroupOp(id, email, group);
          op.label = `${projectName(id)}: lägg till i ${group.name}`;
          ops.push(op);
        } else if (row && existing && row.groups.has(existing.id)) {
          const op = removeFromGroupOp(id, email, existing, row.groups.get(existing.id));
          op.label = `${projectName(id)}: ta bort från ${existing.name}`;
          ops.push(op);
        } else {
          skipped.push(`${email}: inget att ta bort i ${projectName(id)}`);
        }
      }
    }
    return { ops, skipped };
  }

  $("#mx-preview").addEventListener("click", () => {
    const { ops, skipped } = buildOps();
    const touched = [...new Set([...state.changes.keys()].map((key) => key.split("|")[0]))];
    showPreview(ops, skipped, async () => {
      state.changes.clear();
      await ensureLoaded(touched, true);
      render();
    });
  });

  $("#mx-reset").addEventListener("click", () => {
    state.changes.clear();
    render();
  });
  $("#mx-show").addEventListener("click", show);
  $("#mx-group").addEventListener("keydown", (event) => event.key === "Enter" && show());

  renderPicker();
  ensureLoaded([currentProjectId]);

  return {
    /** Reuse a project the main view already loaded. */
    seed(data) {
      state.loaded.set(data.projectId, data);
      renderGroupNames();
    },
  };
}
