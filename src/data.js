/**
 * User manager data layer.
 *
 * rest(path, { method, body }) goes through StreamBIM.API.makeApiRequest live,
 * or through an in-memory mock on localhost. Both return parsed JSON:API.
 *
 * makeApiRequest hides HTTP status: every error, and some successful writes
 * (201/204), arrive as a DataCloneError. Such errors are marked `blind`, and
 * the batch runner re-reads the server to see whether the write landed.
 */

import { createMockDb, mockMe, mockOrganizations, mockProjects } from "./mock-users.js";

/** Pause between writes. Keeps a batch at roughly four requests a second. */
export const WRITE_GAP_MS = 250;

export const LEVELS = [
  [0, "Inaktiv"],
  [5, "Gäst"],
  [10, "Användare"],
  [15, "Arbetsflödesadmin"],
  [20, "Projektadmin"],
  [25, "Kundadmin"],
  [30, "Ägare"],
];

/** Levels a project admin may hand out. Higher ones are rejected by the server. */
export const ASSIGNABLE_LEVELS = LEVELS.filter(([level]) => level <= 20);

export function levelName(level) {
  return LEVELS.find(([value]) => value === level)?.[1] ?? String(level);
}

export function parseLevel(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  return LEVELS.find(([, name]) => name.toLowerCase() === value)?.[0] ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RestError extends Error {
  constructor(message, blind) {
    super(message);
    this.blind = blind;
  }
}

/** REST through the live widget API. */
export function liveRest(api) {
  return async (path, { method = "GET", body } = {}) => {
    const opts = { url: path, method };
    if (body !== undefined) opts.body = body;
    let text;
    try {
      text = await api.makeApiRequest(opts);
    } catch (error) {
      const blind = /could not be cloned/i.test(error?.message ?? "");
      throw new RestError(blind ? `${method} ${path}: okänt svar` : error?.message || String(error), blind);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
}

/** REST against fake data, with the same JSON:API shapes as the live server. */
export function mockRest() {
  const db = createMockDb();

  const member = (projectId, m) => ({
    id: `${projectId}-${m.email}`,
    type: "project-members",
    attributes: {
      "given-name": m.given,
      "family-name": m.family,
      organization: m.organization,
      title: m.title,
      phone: m.phone,
      "privilege-level": m.level,
      guest: m.guest,
      invited: m.invited,
      "last-login": m.lastLogin,
    },
    relationships: {
      user: { data: { type: "users", id: m.email } },
      "user-organization": { data: m.orgId ? { type: "user-organizations", id: m.orgId } : null },
    },
  });

  const groupMember = (gm) => ({
    id: gm.id,
    type: "group-members",
    attributes: { "is-admin": gm.admin },
    relationships: {
      group: { data: { type: "groups", id: gm.group } },
      user: { data: { type: "users", id: gm.user } },
    },
  });

  const fail = (message) => {
    throw new RestError(message, true);
  };

  return async (path, { method = "GET", body } = {}) => {
    await sleep(60);
    if (path.startsWith("/mgw/api/v3/projects")) {
      return { data: mockProjects.map((p) => ({ id: p.id, type: "projects", attributes: { name: p.name } })) };
    }
    if (path.startsWith("/mgw/api/v3/user-organizations")) {
      return {
        data: mockOrganizations.map((o) => ({ id: o.id, type: "user-organizations", attributes: { name: o.name } })),
      };
    }
    const match = path.match(/^\/project-(\d+)\/api\/v1\/v2\/([a-z-]+)(?:\/([^?]+))?/);
    if (!match) fail(`${method} ${path}: okänt svar`);
    const [, projectId, resource, rawId] = match;
    const id = rawId && decodeURIComponent(rawId);
    const p = db.project(projectId);
    if (!p) fail(`${method} ${path}: okänt svar`);

    if (resource === "project-members") {
      if (method === "GET" && !id) return { data: p.members.map((m) => member(projectId, m)) };
      const email = (id ?? body?.data?.id ?? "").replace(`${projectId}-`, "");
      let m = p.members.find((item) => item.email === email);
      if (method === "GET") return m ? { data: member(projectId, m) } : fail(`GET ${path}: okänt svar`);
      const a = body?.data?.attributes ?? {};
      const org = body?.data?.relationships?.["user-organization"]?.data;
      if (method === "POST") {
        if (m) fail(`POST ${path}: okänt svar`);
        m = { email, given: "", family: "", organization: "", orgId: null, title: "", phone: "", level: 10, guest: false, invited: false, lastLogin: null };
        p.members.push(m);
        p.groupMembers.push({ id: db.nextId(), group: "1", user: email, admin: false });
      } else if (method !== "PATCH" || !m) {
        fail(`${method} ${path}: okänt svar`);
      }
      if (method === "PATCH" && email === mockMe && "privilege-level" in a) fail(`PATCH ${path}: okänt svar`);
      if ("given-name" in a) m.given = a["given-name"];
      if ("family-name" in a) m.family = a["family-name"];
      if ("organization" in a) m.organization = a.organization;
      if ("title" in a) m.title = a.title;
      if ("phone" in a) m.phone = a.phone;
      if ("privilege-level" in a) m.level = a["privilege-level"];
      if ("guest" in a) m.guest = a.guest;
      if ("invited" in a) m.invited = a.invited;
      if (org !== undefined) m.orgId = org?.id ?? null;
      return { data: member(projectId, m) };
    }
    if (resource === "users" && method === "GET") {
      return {
        data: p.members.map((m) => ({
          id: m.email,
          type: "users",
          attributes: { name: `${m.given} ${m.family}`.trim(), "first-name": m.given, "last-name": m.family, organization: m.organization },
        })),
      };
    }
    if (resource === "groups" && method === "GET") {
      return {
        data: p.groups.map((g) => ({
          id: g.id,
          type: "groups",
          attributes: { name: g.name, description: g.description, organization: "", "is-read-only": g.readOnly },
        })),
      };
    }
    if (resource === "group-members") {
      if (method === "GET") return { data: p.groupMembers.map(groupMember) };
      if (method === "POST") {
        const rel = body?.data?.relationships ?? {};
        const gm = {
          id: db.nextId(),
          group: rel.group?.data?.id,
          user: rel.user?.data?.id,
          admin: Boolean(body?.data?.attributes?.["is-admin"]),
        };
        if (p.groupMembers.some((item) => item.group === gm.group && item.user === gm.user)) fail(`POST ${path}: okänt svar`);
        p.groupMembers.push(gm);
        return { data: groupMember(gm) };
      }
      if (method === "DELETE") {
        const index = p.groupMembers.findIndex((item) => item.id === id);
        if (index < 0) fail(`DELETE ${path}: okänt svar`);
        p.groupMembers.splice(index, 1);
        return { data: null };
      }
    }
    return fail(`${method} ${path}: okänt svar`);
  };
}

const base = (projectId) => `/project-${projectId}/api/v1/v2`;
const memberId = (projectId, email) => `${projectId}-${email}`;
const relId = (resource, name) => resource?.relationships?.[name]?.data?.id ?? null;

export async function loadProjects(rest) {
  const res = await rest("/mgw/api/v3/projects");
  return (res?.data ?? [])
    .filter((p) => !p.attributes?.["deleted-at"])
    .map((p) => ({ id: String(p.id), name: p.attributes?.name || `Projekt ${p.id}`, inactive: Boolean(p.attributes?.["is-inactive"]) }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

export async function loadOrganizations(rest) {
  const res = await rest("/mgw/api/v3/user-organizations");
  return (res?.data ?? [])
    .map((o) => ({ id: String(o.id), name: o.attributes?.name || o.id }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

/**
 * Members, groups and memberships for one project, joined into rows.
 * Four reads, run together.
 */
export async function loadProject(rest, projectId) {
  const root = base(projectId);
  const [members, users, groups, groupMembers] = await Promise.all([
    rest(`${root}/project-members`),
    rest(`${root}/users`).catch(() => ({ data: [] })),
    rest(`${root}/groups`),
    rest(`${root}/group-members`),
  ]);

  const userById = new Map((users?.data ?? []).map((u) => [u.id, u.attributes ?? {}]));
  const groupList = (groups?.data ?? [])
    .map((g) => ({
      id: String(g.id),
      name: g.attributes?.name ?? g.id,
      description: g.attributes?.description ?? "",
      readOnly: Boolean(g.attributes?.["is-read-only"] || g.attributes?.["is-imported"]),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));

  const rows = (members?.data ?? []).map((m) => {
    const a = m.attributes ?? {};
    const email = relId(m, "user") ?? String(m.id).replace(`${projectId}-`, "");
    const u = userById.get(email) ?? {};
    const given = a["given-name"] || u["first-name"] || "";
    const family = a["family-name"] || u["last-name"] || "";
    return {
      email,
      given,
      family,
      // StreamBIM reports "@" as the name of users who never filled one in.
      name: `${given} ${family}`.trim() || (/\p{L}/u.test(u.name ?? "") ? u.name : ""),
      organization: a.organization || u.organization || "",
      orgId: relId(m, "user-organization"),
      title: a.title || u.title || "",
      phone: a.phone || u.phone || "",
      level: Number(a["privilege-level"] ?? 0),
      guest: Boolean(a.guest),
      invited: Boolean(a.invited),
      lastLogin: a["last-login"] || null,
      groups: new Map(),
    };
  });

  const rowByEmail = new Map(rows.map((row) => [row.email, row]));
  for (const gm of groupMembers?.data ?? []) {
    const row = rowByEmail.get(relId(gm, "user"));
    if (row) row.groups.set(String(relId(gm, "group")), String(gm.id));
  }
  rows.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, "sv"));
  return { projectId, rows, rowByEmail, groups: groupList };
}

/* ---------- Operations: one REST write each, with a check for blind results ---------- */

function memberBody(projectId, email, attributes, orgId) {
  const data = {
    type: "project-members",
    id: memberId(projectId, email),
    attributes,
    relationships: {
      project: { data: { type: "projects", id: String(projectId) } },
      user: { data: { type: "users", id: email } },
    },
  };
  if (orgId !== undefined) {
    data.relationships["user-organization"] = { data: orgId ? { type: "user-organizations", id: orgId } : null };
  }
  return { data };
}

async function readMember(rest, projectId, email) {
  try {
    const res = await rest(`${base(projectId)}/project-members/${encodeURIComponent(memberId(projectId, email))}`);
    return res?.data?.attributes ?? null;
  } catch {
    return null;
  }
}

/** Change fields on an existing member. `attributes` uses API names (given-name, title, …). */
export function patchMemberOp(projectId, row, attributes, orgId, label) {
  return {
    label,
    who: row.email,
    method: "PATCH",
    path: `${base(projectId)}/project-members/${encodeURIComponent(memberId(projectId, row.email))}`,
    body: memberBody(projectId, row.email, attributes, orgId),
    async check(rest) {
      const now = await readMember(rest, projectId, row.email);
      return Boolean(now) && Object.entries(attributes).every(([key, value]) => now[key] === value);
    },
  };
}

/** Add someone as a member of a project (no invitation unless `invite`). */
export function addMemberOp(projectId, email, attributes, orgId, label) {
  return {
    label,
    who: email,
    method: "POST",
    path: `${base(projectId)}/project-members`,
    body: memberBody(projectId, email, { invited: false, ...attributes }, orgId),
    async check(rest) {
      return Boolean(await readMember(rest, projectId, email));
    },
  };
}

async function groupMembers(rest, projectId, cache) {
  cache.groupMembers ??= {};
  cache.groupMembers[projectId] ??= rest(`${base(projectId)}/group-members`).then((res) => res?.data ?? []);
  return cache.groupMembers[projectId];
}

const inGroup = (list, groupId, email) =>
  list.some((gm) => relId(gm, "group") === groupId && relId(gm, "user") === email);

/**
 * POST group-members → 200; 409 if already a member. One pair per request.
 * Verified 2026-11-05 (web app HAR + Rendra's project-mw spec). `admin` makes
 * the user a group administrator.
 */
export function addToGroupOp(projectId, email, group, admin = false) {
  return {
    label: `Lägg till i ${group.name}${admin ? " som gruppadmin" : ""}`,
    who: email,
    method: "POST",
    path: `${base(projectId)}/group-members`,
    body: {
      data: {
        type: "group-members",
        attributes: { "is-admin": admin },
        relationships: {
          group: { data: { type: "groups", id: group.id } },
          user: { data: { type: "users", id: email } },
        },
      },
    },
    async check(rest, cache) {
      return inGroup(await groupMembers(rest, projectId, cache), group.id, email);
    },
  };
}

/** Verified 2026-11-05 from the StreamBIM web app: DELETE group-members/{id} → 200. */
export function removeFromGroupOp(projectId, email, group, groupMemberId) {
  return {
    label: `Ta bort från ${group.name}`,
    who: email,
    method: "DELETE",
    path: `${base(projectId)}/group-members/${groupMemberId}`,
    async check(rest, cache) {
      return !inGroup(await groupMembers(rest, projectId, cache), group.id, email);
    },
  };
}

/**
 * Run operations one at a time, WRITE_GAP_MS apart. Blind results are checked
 * afterwards by re-reading the server. `onUpdate` is called after each step.
 * Returns when done or when `signal.stopped` is set.
 */
export async function runOps(rest, ops, onUpdate, signal = {}) {
  for (const op of ops) op.status = "väntar";
  onUpdate();
  for (const op of ops) {
    if (signal.stopped) break;
    op.status = "kör";
    onUpdate();
    try {
      await rest(op.path, { method: op.method, body: op.body });
      op.status = "ok";
    } catch (error) {
      op.status = error.blind ? "kontrollerar" : "fel";
      op.error = error.message;
    }
    onUpdate();
    await sleep(WRITE_GAP_MS);
  }

  const cache = {};
  for (const op of ops.filter((item) => item.status === "kontrollerar")) {
    if (signal.stopped) break;
    let landed = false;
    try {
      landed = await op.check(rest, cache);
    } catch {
      landed = false;
    }
    op.status = landed ? "ok" : "fel";
    if (landed) op.error = "";
    onUpdate();
    await sleep(WRITE_GAP_MS / 2);
  }
  for (const op of ops) if (op.status === "väntar") op.status = "stoppad";
  onUpdate();
}
