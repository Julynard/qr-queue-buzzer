-- Queue addresses are permanent: printed QR codes point at them. When a queue is deleted its slug is kept
-- here, so the address is never given to a different shop.
create table "deleted_slug" (
  "slug" text not null primary key,
  "deleted_at" integer not null
);
