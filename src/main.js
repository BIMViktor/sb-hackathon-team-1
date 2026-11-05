/**
 * User manager: list, filter and batch-edit the members of a StreamBIM project.
 * Connection lives in src/streambim.js, REST and batch logic in src/data.js,
 * the popout window in src/bridge.js.
 */

import { connectBridge, serveBridge } from "./bridge.js";
import {
  ASSIGNABLE_LEVELS,
  LEVELS,
  WRITE_GAP_MS,
  addMemberOp,
  addToGroupOp,
  lastAdminKept,
  levelName,
  liveRest,
  loadOrganizations,
  loadProject,
  loadProjects,
  mockRest,
  parseLevel,
  patchMemberOp,
  removeFromGroupOp,
  runOps,
} from "./data.js";
import { createMatrix } from "./matrix.js";
import { mockMe, mockProjects } from "./mock-users.js";
import { connectWidget } from "./streambim.js";
import { esc, option } from "./ui.js";
import "./style.css";

const $ = (selector) => document.querySelector(selector);
const el = {
  status: $("#status"),
  popout: $("#popout"),
  project: $("#project"),
  reload: $("#reload"),
  search: $("#search"),
  fLevel: $("#f-level"),
  fGroup: $("#f-group"),
  fOrg: $("#f-org"),
  selectAll: $("#select-all"),
  count: $("#count"),
  importBtn: $("#import"),
  exportBtn: $("#export"),
  list: $("#list"),
  batch: $("#batch"),
  batchCount: $("#batch-count"),
  action: $("#action"),
  actionFields: $("#action-fields"),
  preview: $("#preview"),
  clear: $("#clear"),
  log: $("#log"),
  sheet: $("#sheet"),
  sheetTitle: $("#sheet-title"),
  sheetBody: $("#sheet-body"),
  sheetClose: $("#sheet-close"),
  orgList: $("#org-list"),
  tabs: $("#tabs"),
  usersView: $("#users-view"),
  matrixView: $("#matrix-view"),
};

const ctx = { rest: null, projectId: "", userEmail: "", mode: "" };
const state = {
  projects: [],
  orgs: [],
  data: null,
  selected: new Set(),
  running: null,
  matrix: null,
};

/* ---------- helpers ---------- */

function log(message, kind = "") {
  el.log.textContent = message;
  el.log.dataset.kind = kind;
}

const writableGroups = () => (state.data?.groups ?? []).filter((group) => !group.readOnly);
const groupById = (id) => state.data?.groups.find((group) => group.id === id);
const orgByName = (name) => state.orgs.find((org) => org.name.toLowerCase() === String(name).trim().toLowerCase());
const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString("sv-SE") : "–");
const isMe = (row) => row.email.toLowerCase() === ctx.userEmail.toLowerCase();

/* ---------- connection ---------- */

function loadWidgetApi() {
  if (window.StreamBIM?.connectToParent) return Promise.resolve();
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = `${import.meta.env.BASE_URL}streambim-widget-api.min.js`;
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.append(script);
  });
}

async function connect() {
  const params = new URLSearchParams(location.search);
  const popout = params.has("popout");
  if (popout) {
    document.body.classList.add("wide");
    el.popout.hidden = true;
    const bridge = connectBridge();
    if (!bridge) throw new Error("Öppna det stora fönstret från widgeten i StreamBIM.");
    Object.assign(ctx, await bridge.context(), { rest: bridge.rest });
    return;
  }
  if (params.has("mock")) {
    Object.assign(ctx, { rest: mockRest(), projectId: mockProjects[0].id, userEmail: mockMe, mode: "mock" });
    serveBridge(() => ctx);
    return;
  }
  await loadWidgetApi();
  const client = await connectWidget({});
  if (client.mode === "live") {
    Object.assign(ctx, {
      rest: liveRest(client.api),
      projectId: String(await client.getProjectId()),
      userEmail: String(await client.getUserEmail()),
      mode: "live",
    });
  } else if (client.mode === "mock") {
    Object.assign(ctx, { rest: mockRest(), projectId: mockProjects[0].id, userEmail: mockMe, mode: "mock" });
  } else {
    throw new Error(client.reason || "Ingen kontakt med StreamBIM.");
  }
  serveBridge(() => ctx);
}

/* ---------- loading ---------- */

async function loadAll(projectId) {
  el.list.innerHTML = `<p class="empty">Laddar…</p>`;
  state.selected.clear();
  try {
    state.data = await loadProject(ctx.rest, projectId);
    log(`${state.data.rows.length} medlemmar, ${state.data.groups.length} grupper.`);
  } catch (error) {
    state.data = null;
    el.list.innerHTML = `<p class="empty">Kunde inte läsa projektets användare. Du behöver vara projektadmin.</p>`;
    log(error.message, "error");
    return;
  }
  renderFilters();
  render();
}

function renderProjects(selectedId) {
  const known = state.projects.some((project) => project.id === selectedId);
  const list = known ? state.projects : [{ id: selectedId, name: `Projekt ${selectedId}` }, ...state.projects];
  el.project.innerHTML = list
    .map((p) => option(p.id, `${p.name}${p.id === ctx.projectId ? " (öppet)" : ""}${p.inactive ? " · inaktivt" : ""}`, p.id === selectedId))
    .join("");
}

function renderFilters() {
  const keep = { level: el.fLevel.value, group: el.fGroup.value, org: el.fOrg.value };
  el.fLevel.innerHTML = option("", "Alla roller") + LEVELS.map(([value, name]) => option(value, name)).join("");
  el.fGroup.innerHTML =
    option("", "Alla grupper") +
    option("__none", "Utan egen grupp") +
    (state.data?.groups ?? []).map((g) => option(g.id, g.name)).join("");
  const orgs = [...new Set((state.data?.rows ?? []).map((row) => row.organization).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "sv"),
  );
  el.fOrg.innerHTML = option("", "Alla organisationer") + option("__none", "Saknar organisation") + orgs.map((o) => option(o, o)).join("");
  el.fLevel.value = keep.level;
  el.fGroup.value = [...el.fGroup.options].some((o) => o.value === keep.group) ? keep.group : "";
  el.fOrg.value = [...el.fOrg.options].some((o) => o.value === keep.org) ? keep.org : "";
}

/* ---------- list ---------- */

function filteredRows() {
  const rows = state.data?.rows ?? [];
  const query = el.search.value.trim().toLowerCase();
  const level = el.fLevel.value;
  const group = el.fGroup.value;
  const org = el.fOrg.value;
  const ownGroups = new Set(writableGroups().map((g) => g.id));
  return rows.filter((row) => {
    if (level !== "" && row.level !== Number(level)) return false;
    if (group === "__none" && [...row.groups.keys()].some((id) => ownGroups.has(id))) return false;
    if (group && group !== "__none" && !row.groups.has(group)) return false;
    if (org === "__none" && row.organization) return false;
    if (org && org !== "__none" && row.organization !== org) return false;
    if (!query) return true;
    return [row.name, row.email, row.organization, row.title].some((value) => value.toLowerCase().includes(query));
  });
}

function groupChips(row) {
  const names = [...row.groups.keys()]
    .map(groupById)
    .filter((group) => group && !group.readOnly)
    .map((group) =>
      row.adminOf.has(group.id)
        ? `<span class="chip admin" title="Gruppadmin">★ ${esc(group.name.replace(/^@/, ""))}</span>`
        : `<span class="chip">${esc(group.name.replace(/^@/, ""))}</span>`,
    );
  return names.join("") || `<span class="muted">–</span>`;
}

function render() {
  if (!state.data) return;
  const rows = filteredRows();
  for (const email of [...state.selected]) if (!state.data.rowByEmail.has(email)) state.selected.delete(email);

  el.count.textContent =
    `${rows.length} av ${state.data.rows.length} användare` + (state.selected.size ? ` · ${state.selected.size} valda` : "");
  const selectedVisible = rows.filter((row) => state.selected.has(row.email)).length;
  el.selectAll.checked = rows.length > 0 && selectedVisible === rows.length;
  el.selectAll.indeterminate = selectedVisible > 0 && selectedVisible < rows.length;

  if (!rows.length) {
    el.list.innerHTML = `<p class="empty">Inga användare matchar filtret.</p>`;
  } else {
    el.list.innerHTML = `
      <table class="users">
        <thead><tr>
          <th></th><th>Namn</th><th>Roll</th><th>Organisation</th><th>Titel</th><th>Grupper</th><th>Senast inne</th><th></th>
        </tr></thead>
        <tbody>${rows
          .map(
            (row) => `
          <tr data-email="${esc(row.email)}" class="${state.selected.has(row.email) ? "on" : ""} ${row.level === 0 ? "inactive" : ""}">
            <td class="c-check"><input type="checkbox" ${state.selected.has(row.email) ? "checked" : ""} aria-label="Välj ${esc(row.email)}" /></td>
            <td class="c-name"><b>${esc(row.name || row.email)}</b>${isMe(row) ? ` <span class="you">du</span>` : ""}<small>${esc(row.email)}</small></td>
            <td class="c-level" data-sub="${esc([row.organization, row.title].filter(Boolean).join(" · "))}"><span class="level l${row.level}">${esc(levelName(row.level))}</span>${row.invited ? `<small>inbjuden</small>` : ""}</td>
            <td class="c-org">${esc(row.organization) || `<span class="muted">–</span>`}</td>
            <td class="c-title">${esc(row.title) || `<span class="muted">–</span>`}</td>
            <td class="c-groups">${groupChips(row)}</td>
            <td class="c-login">${shortDate(row.lastLogin)}</td>
            <td class="c-edit"><button type="button" class="ghost icon edit" title="Redigera">✎</button></td>
          </tr>`,
          )
          .join("")}</tbody>
      </table>`;
  }
  renderBatch();
}

function renderBatch() {
  const n = state.selected.size;
  el.batch.hidden = n === 0 || !el.matrixView.hidden;
  el.batchCount.textContent = `${n} valda`;
}

function renderActionFields() {
  const action = el.action.value;
  const groups = writableGroups();
  const fields = {
    level: `<select id="a-level">${ASSIGNABLE_LEVELS.filter(([v]) => v > 0)
      .map(([v, name]) => option(v, name, v === 10))
      .join("")}</select>`,
    org: `<input id="a-org" list="org-list" placeholder="Organisation" />`,
    title: `<input id="a-title" placeholder="Titel (tomt = rensa)" />`,
    addGroup: `<select id="a-group">${groups.map((g) => option(g.id, g.name)).join("")}</select>
      <label class="check"><input id="a-admin" type="checkbox" /> som gruppadmin</label>`,
    removeGroup: `<select id="a-group">${groups.map((g) => option(g.id, g.name)).join("")}</select>`,
    copy: `<select id="a-project">${state.projects
      .filter((p) => p.id !== state.data?.projectId && !p.inactive)
      .map((p) => option(p.id, p.name))
      .join("")}</select>`,
    deactivate: "",
  };
  el.actionFields.innerHTML = fields[action] ?? "";
}

/* ---------- building operations ---------- */

async function buildBatchOps() {
  const action = el.action.value;
  const projectId = state.data.projectId;
  const rows = [...state.selected].map((email) => state.data.rowByEmail.get(email)).filter(Boolean);
  const ops = [];
  const skipped = [];
  const val = (id) => el.actionFields.querySelector(id)?.value ?? "";

  if (action === "level" || action === "deactivate") {
    const level = action === "deactivate" ? 0 : Number(val("#a-level"));
    for (const row of rows) {
      if (isMe(row)) skipped.push(`${row.email}: du kan inte ändra din egen roll`);
      else if (row.level === level) skipped.push(`${row.email}: är redan ${levelName(level)}`);
      else if (row.level > 20) skipped.push(`${row.email}: ${levelName(row.level)} kan inte ändras härifrån`);
      else
        ops.push(
          patchMemberOp(projectId, row, { "privilege-level": level, guest: level === 5 }, undefined, `${levelName(row.level)} → ${levelName(level)}`),
        );
    }
  }
  if (action === "org") {
    const name = val("#a-org").trim();
    if (!name) throw new Error("Skriv en organisation.");
    const org = orgByName(name);
    for (const row of rows) {
      if (row.organization === (org?.name ?? name) && (!org || row.orgId === org.id)) skipped.push(`${row.email}: har redan ${name}`);
      else ops.push(patchMemberOp(projectId, row, { organization: org?.name ?? name }, org ? org.id : undefined, `Organisation → ${org?.name ?? name}`));
    }
  }
  if (action === "title") {
    const title = val("#a-title").trim();
    for (const row of rows) {
      if (row.title === title) skipped.push(`${row.email}: har redan titeln`);
      else ops.push(patchMemberOp(projectId, row, { title }, undefined, title ? `Titel → ${title}` : "Rensa titel"));
    }
  }
  if (action === "addGroup" || action === "removeGroup") {
    const group = groupById(val("#a-group"));
    if (!group) throw new Error("Välj en grupp.");
    const keep =
      action === "removeGroup" ? lastAdminKept(state.data, group.id, rows.filter((row) => row.groups.has(group.id)).map((row) => row.email)) : null;
    for (const row of rows) {
      const member = row.groups.get(group.id);
      if (action === "addGroup") {
        if (member) skipped.push(`${row.email}: är redan med i ${group.name}`);
        else ops.push(addToGroupOp(projectId, row.email, group, el.actionFields.querySelector("#a-admin")?.checked));
      } else if (!member) skipped.push(`${row.email}: är inte med i ${group.name}`);
      else if (row.email === keep) skipped.push(`${row.email}: sista gruppadmin i ${group.name}, gruppen måste ha minst en`);
      else ops.push(removeFromGroupOp(projectId, row.email, group, member));
    }
  }
  if (action === "copy") {
    const target = val("#a-project");
    if (!target) throw new Error("Välj ett projekt.");
    const targetName = state.projects.find((p) => p.id === target)?.name ?? target;
    let existing = new Set();
    try {
      existing = new Set((await loadProject(ctx.rest, target)).rows.map((row) => row.email));
    } catch {
      throw new Error(`Kan inte läsa ${targetName}. Du behöver vara projektadmin där.`);
    }
    for (const row of rows) {
      if (existing.has(row.email)) {
        skipped.push(`${row.email}: finns redan i ${targetName}`);
        continue;
      }
      const level = row.level === 0 ? 10 : Math.min(row.level, 20);
      ops.push(
        addMemberOp(
          target,
          row.email,
          {
            "privilege-level": level,
            guest: level === 5,
            "given-name": row.given,
            "family-name": row.family,
            organization: row.organization,
            title: row.title,
            phone: row.phone,
          },
          row.orgId ?? undefined,
          `Lägg till i ${targetName} som ${levelName(level)}`,
        ),
      );
    }
  }
  return { ops, skipped };
}

function buildEditOps(row, form) {
  const projectId = state.data.projectId;
  const ops = [];
  const skipped = [];
  const read = (name) => form.elements[name].value.trim();
  const attrs = {};
  if (read("given") !== row.given) attrs["given-name"] = read("given");
  if (read("family") !== row.family) attrs["family-name"] = read("family");
  if (read("title") !== row.title) attrs.title = read("title");
  if (read("phone") !== row.phone) attrs.phone = read("phone");
  let orgId;
  if (read("org") !== row.organization) {
    const org = orgByName(read("org"));
    attrs.organization = org?.name ?? read("org");
    orgId = org ? org.id : null;
  }
  const level = Number(form.elements.level.value);
  if (level !== row.level) Object.assign(attrs, { "privilege-level": level, guest: level === 5 });
  if (Object.keys(attrs).length) {
    const what = Object.keys(attrs)
      .filter((key) => key !== "guest")
      .map((key) => ({ "given-name": "förnamn", "family-name": "efternamn", "privilege-level": "roll" })[key] ?? key)
      .join(", ");
    ops.push(patchMemberOp(projectId, row, attrs, orgId, `Ändra ${what}`));
  }
  for (const group of writableGroups()) {
    const want = form.elements[`g-${group.id}`].checked;
    const member = row.groups.get(group.id);
    if (want && !member) ops.push(addToGroupOp(projectId, row.email, group));
    if (!want && member) {
      if (lastAdminKept(state.data, group.id, [row.email])) skipped.push(`Sista gruppadmin i ${group.name}, gruppen måste ha minst en`);
      else ops.push(removeFromGroupOp(projectId, row.email, group, member));
    }
  }
  return { ops, skipped };
}

/** CSV/TSV: e-post;förnamn;efternamn;organisation;titel;roll;grupper (grupper separerade med |). */
function parseImport(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const cells = line.split(/\t|;|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (!cells[0].includes("@")) continue;
    const [email, given = "", family = "", organization = "", title = "", role = "", groups = ""] = cells;
    rows.push({
      email: email.toLowerCase(),
      given,
      family,
      organization,
      title,
      level: parseLevel(role),
      groups: groups.split("|").map((g) => g.trim()).filter(Boolean),
    });
  }
  return rows;
}

function buildImportOps(entries, defaultLevel, invite) {
  const projectId = state.data.projectId;
  const ops = [];
  const skipped = [];
  const findGroup = (name) => {
    const key = name.replace(/^@/, "").toLowerCase();
    return writableGroups().find((group) => group.name.replace(/^@/, "").toLowerCase() === key);
  };
  for (const entry of entries) {
    const row = state.data.rowByEmail.get(entry.email);
    const org = entry.organization ? orgByName(entry.organization) : null;
    if (row) {
      const attrs = {};
      if (entry.given && entry.given !== row.given) attrs["given-name"] = entry.given;
      if (entry.family && entry.family !== row.family) attrs["family-name"] = entry.family;
      if (entry.organization && entry.organization !== row.organization) attrs.organization = org?.name ?? entry.organization;
      if (entry.title && entry.title !== row.title) attrs.title = entry.title;
      if (entry.level != null && entry.level !== row.level && !isMe(row)) Object.assign(attrs, { "privilege-level": entry.level, guest: entry.level === 5 });
      if (Object.keys(attrs).length) ops.push(patchMemberOp(projectId, row, attrs, attrs.organization && org ? org.id : undefined, "Uppdatera befintlig"));
    } else {
      const level = entry.level ?? defaultLevel;
      ops.push(
        addMemberOp(
          projectId,
          entry.email,
          {
            "privilege-level": level,
            guest: level === 5,
            "given-name": entry.given,
            "family-name": entry.family,
            organization: org?.name ?? entry.organization,
            title: entry.title,
            invited: invite,
            "send-invitation": invite,
          },
          org?.id,
          `Lägg till som ${levelName(level)}${invite ? " + inbjudan" : ""}`,
        ),
      );
    }
    for (const name of entry.groups) {
      const group = findGroup(name);
      if (!group) skipped.push(`${entry.email}: gruppen ${name} finns inte`);
      else if (!row?.groups.has(group.id)) ops.push(addToGroupOp(projectId, entry.email, group));
    }
  }
  return { ops, skipped };
}

/* ---------- sheet (dialog) ---------- */

function openSheet(title, html) {
  el.sheetTitle.textContent = title;
  el.sheetBody.innerHTML = html;
  el.sheet.hidden = false;
}

function closeSheet() {
  if (state.running) return;
  el.sheet.hidden = true;
  el.sheetBody.innerHTML = "";
}

function showPreview(ops, skipped = [], onDone = () => loadAll(el.project.value)) {
  const people = new Set(ops.map((op) => op.who)).size;
  const seconds = Math.ceil((ops.length * WRITE_GAP_MS) / 1000);
  openSheet(
    "Förhandsgranska",
    `
    <p class="lead">${ops.length ? `${ops.length} ändringar för ${people} användare. Tar ungefär ${seconds} s.` : "Inget att ändra."}</p>
    ${ops.length ? `<ol class="ops">${ops.map((op, i) => `<li data-i="${i}"><span class="who">${esc(op.who)}</span><span class="what">${esc(op.label)}</span><span class="st"></span></li>`).join("")}</ol>` : ""}
    ${skipped.length ? `<details class="skipped"><summary>${skipped.length} hoppas över</summary><ul>${skipped.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></details>` : ""}
    <div class="sheet-actions">
      ${ops.length ? `<button type="button" id="run" class="primary">Kör ${ops.length} ändringar</button>` : ""}
      <button type="button" id="cancel" class="ghost">${ops.length ? "Avbryt" : "Stäng"}</button>
    </div>`,
  );
  el.sheetBody.querySelector("#cancel").addEventListener("click", () => {
    if (state.running) state.running.stopped = true;
    else closeSheet();
  });
  el.sheetBody.querySelector("#run")?.addEventListener("click", (event) => execute(ops, event.currentTarget, onDone));
}

async function execute(ops, runBtn, onDone) {
  const signal = { stopped: false };
  state.running = signal;
  runBtn.disabled = true;
  const cancel = el.sheetBody.querySelector("#cancel");
  cancel.textContent = "Stoppa";
  const items = el.sheetBody.querySelectorAll(".ops li");
  const update = () => {
    ops.forEach((op, i) => {
      items[i].dataset.status = op.status;
      items[i].querySelector(".st").textContent = op.status === "fel" ? `fel` : op.status;
      items[i].title = op.error || "";
    });
    const done = ops.filter((op) => ["ok", "fel", "stoppad"].includes(op.status)).length;
    runBtn.textContent = `${done} / ${ops.length}`;
  };
  await runOps(ctx.rest, ops, update, signal);
  state.running = null;
  const ok = ops.filter((op) => op.status === "ok").length;
  const failed = ops.filter((op) => op.status === "fel").length;
  const stopped = ops.filter((op) => op.status === "stoppad").length;
  runBtn.textContent = "Klar";
  cancel.textContent = "Stäng";
  const summary = `${ok} lyckades${failed ? `, ${failed} misslyckades` : ""}${stopped ? `, ${stopped} stoppades` : ""}.`;
  el.sheetBody.querySelector(".lead").textContent = summary + (failed ? " Håll muspekaren över en rad för detaljer." : "");
  await onDone();
  log(summary, failed ? "error" : "ok");
}

function openEdit(row) {
  const groups = writableGroups();
  openSheet(
    row.name || row.email,
    `
    <form id="edit" class="form">
      <p class="muted">${esc(row.email)}${row.lastLogin ? ` · senast inne ${shortDate(row.lastLogin)}` : ""}</p>
      <div class="two">
        <label>Förnamn<input name="given" value="${esc(row.given)}" /></label>
        <label>Efternamn<input name="family" value="${esc(row.family)}" /></label>
      </div>
      <label>Organisation<input name="org" list="org-list" value="${esc(row.organization)}" /></label>
      <div class="two">
        <label>Titel<input name="title" value="${esc(row.title)}" /></label>
        <label>Telefon<input name="phone" value="${esc(row.phone)}" placeholder="+46…" /></label>
      </div>
      <label>Roll<select name="level" ${isMe(row) || row.level > 20 ? "disabled" : ""}>${(row.level > 20 ? LEVELS : ASSIGNABLE_LEVELS)
        .map(([v, name]) => option(v, name, v === row.level))
        .join("")}</select></label>
      ${isMe(row) ? `<p class="muted">Du kan inte ändra din egen roll.</p>` : ""}
      <fieldset><legend>Grupper</legend><div class="group-grid">
        ${groups.map((g) => `<label class="check"><input type="checkbox" name="g-${g.id}" ${row.groups.has(g.id) ? "checked" : ""} /> ${esc(g.name)}${row.adminOf.has(g.id) ? ` <span class="muted" title="Gruppadmin">★</span>` : ""}</label>`).join("")}
      </div></fieldset>
      <div class="sheet-actions"><button class="primary" type="submit">Förhandsgranska</button></div>
    </form>`,
  );
  el.sheetBody.querySelector("#edit").addEventListener("submit", (event) => {
    event.preventDefault();
    const { ops, skipped } = buildEditOps(row, event.currentTarget);
    showPreview(ops, skipped);
  });
}

function openImport() {
  openSheet(
    "Lägg till och uppdatera",
    `
    <form id="import-form" class="form">
      <p class="muted">En användare per rad. Kolumner (semikolon, komma eller tabb):<br/>
      <code>e-post;förnamn;efternamn;organisation;titel;roll;grupper</code><br/>
      Roll som namn eller nivå (Gäst, Användare, Projektadmin…). Flera grupper skiljs med <code>|</code>.
      Befintliga användare uppdateras bara i ifyllda fält. Klistra gärna in från Excel.</p>
      <textarea name="text" rows="8" placeholder="kalle@firma.se;Kalle;Ek;Firma AB;Konstruktör;Användare;@Projektering|@Produktion"></textarea>
      <div class="two">
        <label>Roll om tom<select name="level">${ASSIGNABLE_LEVELS.filter(([v]) => v > 0)
          .map(([v, n]) => option(v, n, v === 10))
          .join("")}</select></label>
        <label class="check inline"><input type="checkbox" name="invite" /> Skicka inbjudningsmejl till nya</label>
      </div>
      <div class="sheet-actions"><button class="primary" type="submit">Förhandsgranska</button></div>
    </form>`,
  );
  el.sheetBody.querySelector("#import-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const entries = parseImport(form.elements.text.value);
    if (!entries.length) return log("Hittade inga rader med e-postadress.", "error");
    const { ops, skipped } = buildImportOps(entries, Number(form.elements.level.value), form.elements.invite.checked);
    showPreview(ops, skipped);
  });
}

function openExport() {
  const rows = filteredRows();
  const cell = (value) => (/[;"\n]/.test(value) ? `"${String(value).replace(/"/g, '""')}"` : value);
  const csv = [
    "e-post;förnamn;efternamn;organisation;titel;roll;grupper",
    ...rows.map((row) =>
      [
        row.email,
        row.given,
        row.family,
        row.organization,
        row.title,
        levelName(row.level),
        [...row.groups.keys()].map(groupById).filter((g) => g && !g.readOnly).map((g) => g.name).join("|"),
      ]
        .map(cell)
        .join(";"),
    ),
  ].join("\n");
  openSheet(
    `Exportera ${rows.length} användare`,
    `
    <p class="muted">Samma format som importen: ändra i Excel och klistra tillbaka under <b>Lägg till</b>.</p>
    <textarea rows="10" readonly>${esc(csv)}</textarea>
    <div class="sheet-actions">
      <button type="button" id="copy" class="primary">Kopiera</button>
      <a id="download" class="button ghost" download="anvandare-${esc(state.data.projectId)}.csv">Ladda ner .csv</a>
    </div>`,
  );
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  el.sheetBody.querySelector("#download").href = URL.createObjectURL(blob);
  el.sheetBody.querySelector("#copy").addEventListener("click", async (event) => {
    const area = el.sheetBody.querySelector("textarea");
    try {
      await navigator.clipboard.writeText(csv);
    } catch {
      area.select();
      document.execCommand("copy");
    }
    event.currentTarget.textContent = "Kopierat";
  });
}

/* ---------- events ---------- */

el.list.addEventListener("click", (event) => {
  const tr = event.target.closest("tr[data-email]");
  if (!tr) return;
  const row = state.data.rowByEmail.get(tr.dataset.email);
  if (event.target.closest(".edit")) return openEdit(row);
  if (event.target.closest("a, button")) return;
  if (state.selected.has(row.email)) state.selected.delete(row.email);
  else state.selected.add(row.email);
  render();
});

el.selectAll.addEventListener("change", () => {
  const rows = filteredRows();
  if (el.selectAll.checked) rows.forEach((row) => state.selected.add(row.email));
  else rows.forEach((row) => state.selected.delete(row.email));
  render();
});

for (const input of [el.search, el.fLevel, el.fGroup, el.fOrg]) input.addEventListener("input", render);
el.project.addEventListener("change", () => loadAll(el.project.value));
el.reload.addEventListener("click", () => loadAll(el.project.value));
el.action.addEventListener("change", renderActionFields);
el.clear.addEventListener("click", () => {
  state.selected.clear();
  render();
});
el.preview.addEventListener("click", async () => {
  try {
    const { ops, skipped } = await buildBatchOps();
    showPreview(ops, skipped);
  } catch (error) {
    log(error.message, "error");
  }
});
el.importBtn.addEventListener("click", () => state.data && openImport());
el.exportBtn.addEventListener("click", () => state.data && openExport());
el.sheetClose.addEventListener("click", closeSheet);
el.sheet.addEventListener("click", (event) => event.target === el.sheet && closeSheet());
document.addEventListener("keydown", (event) => event.key === "Escape" && closeSheet());
el.popout.addEventListener("click", () => {
  const win = window.open(`${location.pathname}?popout=1`, "user-manager", "popup,width=1280,height=820");
  if (!win) log("Webbläsaren blockerade fönstret. Tillåt popup-fönster för StreamBIM.", "error");
});

el.tabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (!tab || !ctx.rest) return;
  for (const button of el.tabs.querySelectorAll("[data-tab]")) button.setAttribute("aria-selected", String(button === tab));
  const matrix = tab.dataset.tab === "matrix";
  el.usersView.hidden = matrix;
  el.matrixView.hidden = !matrix;
  el.batch.hidden = matrix || state.selected.size === 0;
  if (matrix && !state.matrix) {
    state.matrix = createMatrix({
      root: el.matrixView,
      rest: ctx.rest,
      projects: state.projects.length ? state.projects : [{ id: ctx.projectId, name: `Projekt ${ctx.projectId}` }],
      currentProjectId: ctx.projectId,
      showPreview,
      log,
    });
    if (state.data) state.matrix.seed(state.data);
  }
});

/* ---------- start ---------- */

const modeLabel = { mock: "Lokalt", live: "Live", error: "Ingen kontakt" };

(async () => {
  try {
    await connect();
  } catch (error) {
    el.status.dataset.mode = "error";
    el.status.textContent = modeLabel.error;
    el.list.innerHTML = `<p class="empty">${esc(error.message)}</p>`;
    return;
  }
  el.status.dataset.mode = ctx.mode;
  el.status.textContent = modeLabel[ctx.mode] || ctx.mode;
  renderProjects(ctx.projectId);
  const [projects, orgs] = await Promise.allSettled([loadProjects(ctx.rest), loadOrganizations(ctx.rest)]);
  state.projects = projects.status === "fulfilled" ? projects.value : [];
  state.orgs = orgs.status === "fulfilled" ? orgs.value : [];
  el.orgList.innerHTML = state.orgs.map((org) => `<option value="${esc(org.name)}"></option>`).join("");
  renderProjects(ctx.projectId);
  await loadAll(ctx.projectId);
  renderActionFields();
})();
