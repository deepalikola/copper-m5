-- Refunds and the auto-refund limit (Module 4). The app's rule in
-- lib/copper/refunds.ts decides every refund; the database backs it up:
--   * order_id is the primary key, so an order can never be refunded twice.
--   * the checks keep statuses, amounts and the limit valid (a limit of 0 is
--     allowed: every refund then needs a person; negative limits are not).
--   * row-level security is on with no policies, and anon/authenticated have
--     no access, so only the server (service-role key) can read or write.

create table refunds (
  order_id text primary key,
  item text not null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null
    check (status in ('processing', 'pending', 'refunded', 'rejected')),
  decided_by text check (decided_by in ('auto', 'supervisor')),
  limit_cents integer not null check (limit_cents >= 0),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  -- A refund that is paid or rejected has been decided by someone.
  check (status not in ('refunded', 'rejected') or decided_by is not null)
);

create table app_settings (
  key text primary key,
  value integer not null
);

-- $50, the course default. A person can change it on the Refund Console.
insert into app_settings (key, value) values ('refund_limit_cents', 5000);

-- The limit must stay a whole number of cents, never negative.
alter table app_settings
  add constraint refund_limit_not_negative
  check (key <> 'refund_limit_cents' or value >= 0);

alter table refunds enable row level security;
alter table app_settings enable row level security;

-- Supabase's browser-facing roles get nothing. (Guarded, so the migration
-- also runs on a plain Postgres without those roles, like the tests do.)
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on refunds, app_settings from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on refunds, app_settings from authenticated;
  end if;
end $$;
