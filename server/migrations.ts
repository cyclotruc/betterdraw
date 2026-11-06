// Versioned schema. Each migration runs once, in order, inside a transaction, and is recorded in
// schema_migrations. Shared SQL is written for Postgres and translated for SQLite by db.ts; a migration
// that cannot be shared gives one text per engine. Never edit a migration that has shipped: add a new one.
// A build that extends this version (extend.ts) runs every one of these on its database, then its own:
//   - never ship a migration that deletes or rewrites data such a build may still use, such as a table this
//     version no longer reads or rows of hits;
//   - an extension's migrations take ids that start with a prefix of their own (acme_001_…), never a bare number.
export type Migration = { id: string; sql?: string; pg?: string; sqlite?: string };

export const migrations: Migration[] = [
  {
    id: "001_auth",
    pg: `create table if not exists "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null, "isAnonymous" boolean);

create table if not exists "session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table if not exists "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table if not exists "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create index if not exists "session_userId_idx" on "session" ("userId");

create index if not exists "account_userId_idx" on "account" ("userId");

create index if not exists "verification_identifier_idx" on "verification" ("identifier");`,
    sqlite: `create table if not exists "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "isAnonymous" integer);

create table if not exists "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table if not exists "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table if not exists "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create index if not exists "session_userId_idx" on "session" ("userId");

create index if not exists "account_userId_idx" on "account" ("userId");

create index if not exists "verification_identifier_idx" on "verification" ("identifier");`,
  },
  {
    id: "002_app",
    sql: `create table if not exists canvases (
  id text primary key,
  owner_id text not null references "user"(id) on delete cascade,
  title text not null default '',
  link_access text not null default 'edit', -- edit | view | none : what the URL gives to anyone who has it
  seq bigint not null default 0,
  app_state jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists elements (
  canvas_id text not null references canvases(id) on delete cascade,
  element_id text not null,
  seq bigint not null,
  data jsonb not null,
  primary key (canvas_id, element_id)
);
create index if not exists elements_seq_idx on elements (canvas_id, seq);

-- owner | editor | viewer. Members and people who claimed a share link both live here.
create table if not exists canvas_access (
  canvas_id text not null references canvases(id) on delete cascade,
  user_id text not null references "user"(id) on delete cascade,
  role text not null,
  via_link boolean not null default false,
  primary key (canvas_id, user_id)
);

create table if not exists files (
  canvas_id text not null references canvases(id) on delete cascade,
  file_id text not null,
  mime text not null,
  size int not null,
  created_at timestamptz not null default now(),
  primary key (canvas_id, file_id)
);

-- Per-user preferences (accent colour, theme). Follows the account, so it survives a new browser.
create table if not exists user_prefs (
  user_id text primary key references "user"(id) on delete cascade,
  prefs jsonb not null default '{}'
);`,
  },
  {
    id: "003_v1",
    sql: `alter table canvases add column deleted_at timestamptz;
alter table canvases add column blocked_at timestamptz;
-- Number of elements that are not deleted, kept by the room on every flush: "empty" without parsing JSON.
alter table canvases add column live integer not null default 0;
create index if not exists canvases_owner_idx on canvases (owner_id);
create index if not exists canvas_access_user_idx on canvas_access (user_id);
create table if not exists reports (
  id text primary key,
  canvas_id text not null references canvases(id) on delete cascade,
  reporter_id text,
  reason text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  action text
);
create table if not exists user_library (
  user_id text primary key references "user"(id) on delete cascade,
  items jsonb not null default '[]',
  updated_at timestamptz not null default now()
);`,
    pg: `update canvases set live = (select count(*) from elements e where e.canvas_id = canvases.id and coalesce(e.data->>'isDeleted', 'false') <> 'true');`,
    sqlite: `update canvases set live = (select count(*) from elements e where e.canvas_id = canvases.id and coalesce(json_extract(e.data, '$.isDeleted'), 0) = 0);`,
  },
  {
    id: "004_activity",
    // One row per person and day they opened a canvas (UTC day, YYYY-MM-DD), for the admin dashboard.
    sql: `create table if not exists activity (
  day text not null,
  user_id text not null references "user"(id) on delete cascade,
  primary key (day, user_id)
);`,
  },
  {
    id: "006_api_keys",
    // Keys that agents use to act for a person. Only a hash is kept; the key is shown once.
    sql: `create table if not exists api_keys (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  name text not null,
  hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists api_keys_user_idx on api_keys (user_id);`,
  },
  {
    id: "007_agent_links",
    // One address per person and canvas that hands the canvas to an agent with that person's rights.
    // Like a canvas address, it is the secret.
    sql: `create table if not exists agent_links (
  token text primary key,
  user_id text not null references "user"(id) on delete cascade,
  canvas_id text not null references canvases(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, canvas_id)
);`,
  },
  {
    id: "008_agent_link_use",
    // When an agent last used a link, shown in the Share panel.
    sql: `alter table agent_links add column last_used_at timestamptz;`,
  },
  {
    id: "009_projects",
    // Each person files the canvases of their list, their own and shared ones, into projects of their own
    // and pins some. Nobody else sees how someone files them.
    sql: `create table if not exists projects (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  name text not null,
  color text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists projects_user_idx on projects (user_id);
create table if not exists canvas_places (
  user_id text not null references "user"(id) on delete cascade,
  canvas_id text not null references canvases(id) on delete cascade,
  project_id text references projects(id) on delete set null,
  pinned boolean not null default false,
  primary key (user_id, canvas_id)
);
create index if not exists canvas_places_project_idx on canvas_places (project_id);`,
  },
  {
    id: "010_analytics",
    // Admins are marked on their account, by hand in the database for now.
    // hits: one row per day, metric and visitor, agent or referring site, with how many times it came.
    sql: `alter table "user" add column "isAdmin" boolean not null default false;
create table if not exists hits (
  day text not null,
  metric text not null,
  who text not null,
  n integer not null default 1,
  primary key (day, metric, who)
);`,
  },
  {
    id: "011_cards",
    // When the image a shared link shows was last drawn; stale once updated_at passes it.
    sql: `alter table canvases add column card_at timestamptz;`,
  },
  {
    id: "012_guest_expiry",
    // A guest's canvases live a day from their creation unless the guest makes an account. Those that
    // already existed get a day from this migration.
    sql: `alter table canvases add column expires_at timestamptz;`,
    pg: `update canvases set expires_at = now() + interval '24 hours' where owner_id in (select id from "user" where "isAnonymous" = true);`,
    sqlite: `update canvases set expires_at = datetime('now', '+24 hours') where owner_id in (select id from "user" where "isAnonymous" = 1);`,
  },
  {
    id: "013_activity_user",
    // The admin's list of people reads each one's last active day.
    sql: `create index if not exists activity_user_idx on activity (user_id, day);`,
  },
  {
    id: "016_storage",
    // What each canvas's drawing weighs (its elements as JSON), kept by its room on every write, and what
    // each person keeps, recorded every hour as the day's figure, for the admin's storage charts.
    sql: `alter table canvases add column bytes bigint not null default 0;
create table if not exists storage_days (
  day text not null,
  user_id text not null references "user"(id) on delete cascade,
  images bigint not null default 0,
  data bigint not null default 0,
  trash bigint not null default 0,
  primary key (day, user_id)
);
update canvases set bytes = coalesce((select sum(octet_length(e.data::text)) from elements e where e.canvas_id = canvases.id), 0);`,
  },
  {
    id: "017_program_guests",
    // A guest made by a program (a script or an agent's program signing itself in, a robot: no browser) is not
    // a person who came by. Marked at sign-in from now on; here, the guests none of whose sessions came from a
    // browser. The one migration changed after it shipped: it also deleted these guests' rows of a table that is
    // no longer part of this version. Databases that applied it keep what it did.
    sql: `alter table "user" add column "isProgram" boolean not null default false;`,
    pg: `update "user" set "isProgram" = true where "isAnonymous" = true
  and exists (select 1 from "session" s where s."userId" = "user".id)
  and not exists (select 1 from "session" s where s."userId" = "user".id
    and coalesce(s."userAgent", '') <> '' and lower(s."userAgent") not like '%bot%' and lower(s."userAgent") not like '%crawl%' and lower(s."userAgent") not like '%spider%' and lower(s."userAgent") not like '%preview%' and lower(s."userAgent") not like '%fetch%' and lower(s."userAgent") not like '%curl%' and lower(s."userAgent") not like '%wget%' and lower(s."userAgent") not like '%python%' and lower(s."userAgent") not like '%headless%' and lower(s."userAgent") not like '%monitor%' and lower(s."userAgent") not like '%lighthouse%' and lower(s."userAgent") not like '%slurp%' and lower(s."userAgent") not like '%facebookexternalhit%' and lower(s."userAgent") not like '%embed%');`,
    sqlite: `update "user" set "isProgram" = 1 where "isAnonymous" = 1
  and exists (select 1 from "session" s where s."userId" = "user".id)
  and not exists (select 1 from "session" s where s."userId" = "user".id
    and coalesce(s."userAgent", '') <> '' and lower(s."userAgent") not like '%bot%' and lower(s."userAgent") not like '%crawl%' and lower(s."userAgent") not like '%spider%' and lower(s."userAgent") not like '%preview%' and lower(s."userAgent") not like '%fetch%' and lower(s."userAgent") not like '%curl%' and lower(s."userAgent") not like '%wget%' and lower(s."userAgent") not like '%python%' and lower(s."userAgent") not like '%headless%' and lower(s."userAgent") not like '%monitor%' and lower(s."userAgent") not like '%lighthouse%' and lower(s."userAgent") not like '%slurp%' and lower(s."userAgent") not like '%facebookexternalhit%' and lower(s."userAgent") not like '%embed%');`,
  },
  {
    id: "019_feedback",
    // What people send from the Feedback button, with the context of the moment; read in the admin.
    sql: `create table if not exists feedback (
  id text primary key,
  kind text not null default 'feedback', -- feedback | bug
  message text not null default '',
  user_id text,
  name text,
  email text,
  guest boolean not null default true,
  context jsonb not null default '{}',
  shots jsonb not null default '[]',
  status text not null default 'new', -- new | done
  created_at timestamptz not null default now()
);
create index if not exists feedback_created_idx on feedback (created_at)`,
  },
  {
    id: "020_admin_views",
    // Each time an admin watched a canvas unseen, for accountability.
    sql: `create table if not exists admin_views (
  admin_id text not null,
  canvas_id text not null,
  at timestamptz not null default now()
);
create index if not exists admin_views_canvas_idx on admin_views (canvas_id, at)`,
  },
];
