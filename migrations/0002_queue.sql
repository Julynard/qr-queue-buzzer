-- One row per queue. The queue's live data (tickets, settings) lives in its Durable Object,
-- addressed by idFromName(id). The slug is the permanent public address /q/<slug>.
create table "queue" (
  "id" text not null primary key,
  "workspace_id" text not null references "organization" ("id") on delete cascade,
  "slug" text not null unique,
  "name" text not null,
  "created_at" integer not null
);
create index "queue_workspace_idx" on "queue" ("workspace_id");
