/**
 * Fake StreamBIM user data for localhost. Shapes follow the JSON:API
 * responses seen on app.streambim.com (project-members, users, groups,
 * group-members, user-organizations, projects).
 */

export const mockMe = "anna.berg@byggbolaget.se";

export const mockProjects = [
  { id: "19513", name: "Sandbox – Kvarteret Linden" },
  { id: "20001", name: "Skola Norra Ängby" },
  { id: "20002", name: "Bostäder Hammarby kaj" },
];

export const mockOrganizations = [
  { id: "501", name: "Byggbolaget AB" },
  { id: "502", name: "Arkitektkontoret Linje" },
  { id: "503", name: "Konstruktion & Co" },
  { id: "504", name: "El-Projekt Syd" },
  { id: "505", name: "Region Stockholm" },
];

const people = [
  ["anna.berg@byggbolaget.se", "Anna", "Berg", "Byggbolaget AB", "Projektchef", 20],
  ["erik.lund@byggbolaget.se", "Erik", "Lund", "Byggbolaget AB", "Platschef", 20],
  ["sara.nilsson@linje.se", "Sara", "Nilsson", "Arkitektkontoret Linje", "Arkitekt", 10],
  ["johan.ek@linje.se", "Johan", "Ek", "Arkitektkontoret Linje", "Handläggare", 10],
  ["maria.holm@konstruktion.se", "Maria", "Holm", "Konstruktion & Co", "Konstruktör", 10],
  ["omar.haddad@konstruktion.se", "Omar", "Haddad", "Konstruktion & Co", "Konstruktör", 10],
  ["lisa.strom@elprojekt.se", "Lisa", "Ström", "El-Projekt Syd", "Elprojektör", 10],
  ["peter.vik@elprojekt.se", "Peter", "Vik", "", "", 5],
  ["karin.sjo@regionstockholm.se", "Karin", "Sjö", "Region Stockholm", "Förvaltare", 15],
  ["ali.yilmaz@byggbolaget.se", "Ali", "Yilmaz", "Byggbolaget AB", "Arbetsledare", 10],
  ["nora.falk@regionstockholm.se", "Nora", "Falk", "Region Stockholm", "Beställare", 5],
  ["gustav.ro@byggbolaget.se", "Gustav", "Ro", "Byggbolaget AB", "BIM-samordnare", 20],
  ["ida.kron@linje.se", "Ida", "Kron", "Arkitektkontoret Linje", "Inredningsarkitekt", 0],
];

const groupNames = [
  ["1", "@Project", "All project members", true],
  ["2", "@Guests", "Guests group", true],
  ["3", "@Projektledning", "", false],
  ["4", "@Projektering", "", false],
  ["5", "@Projektering_Arkitekt", "", false],
  ["6", "@Projektering_Konstruktör", "", false],
  ["7", "@Projektering_El", "", false],
  ["8", "@Produktion", "", false],
  ["9", "@Förvaltning", "", false],
];

const memberships = {
  "@Projektledning": ["anna.berg@byggbolaget.se", "gustav.ro@byggbolaget.se"],
  "@Projektering": ["sara.nilsson@linje.se", "maria.holm@konstruktion.se", "lisa.strom@elprojekt.se"],
  "@Projektering_Arkitekt": ["sara.nilsson@linje.se", "johan.ek@linje.se"],
  "@Projektering_Konstruktör": ["maria.holm@konstruktion.se", "omar.haddad@konstruktion.se"],
  "@Projektering_El": ["lisa.strom@elprojekt.se"],
  "@Produktion": ["erik.lund@byggbolaget.se", "ali.yilmaz@byggbolaget.se"],
  "@Förvaltning": ["karin.sjo@regionstockholm.se"],
};

/** One mutable in-memory database per project, built on first use. */
export function createMockDb() {
  const projects = {};
  let nextId = 100;

  function build(projectId, slice) {
    const chosen = people.slice(0, slice);
    const members = chosen.map(([email, given, family, organization, title, level]) => ({
      email,
      given,
      family,
      organization,
      orgId: mockOrganizations.find((org) => org.name === organization)?.id ?? null,
      title,
      phone: "",
      level,
      guest: level === 5,
      invited: false,
      lastLogin: level ? "2026-10-2" + (email.length % 9) + "T08:15:00Z" : null,
    }));
    // The last project lacks a few groups, so the group × project view has something to create.
    const missing = projectId === mockProjects.at(-1).id ? ["@Projektering_El", "@Förvaltning"] : [];
    const groups = groupNames
      .filter(([, name]) => !missing.includes(name))
      .map(([id, name, description, readOnly]) => ({ id, name, description, readOnly }));
    const groupMembers = [];
    const emails = new Set(members.map((member) => member.email));
    for (const member of members) {
      groupMembers.push({ id: String(nextId++), group: "1", user: member.email, admin: member.level >= 20 });
      if (member.guest) groupMembers.push({ id: String(nextId++), group: "2", user: member.email, admin: false });
    }
    for (const [name, list] of Object.entries(memberships)) {
      const group = groups.find((item) => item.name === name);
      if (!group) continue;
      for (const [i, email] of list.entries()) {
        if (emails.has(email)) groupMembers.push({ id: String(nextId++), group: group.id, user: email, admin: i === 0 });
      }
    }
    return { members, groups, groupMembers };
  }

  return {
    project(projectId) {
      const index = mockProjects.findIndex((project) => project.id === projectId);
      if (index < 0) return null;
      projects[projectId] ??= build(projectId, [people.length, 7, 10][index]);
      return projects[projectId];
    },
    nextId() {
      return String(nextId++);
    },
  };
}
