-- ============================================================
-- Takeoff Copilot — Migration 006: bid-ready pricing (price book)
--
-- A contractor's reusable unit-cost list. Each line item is keyed by its
-- material slug when known (mat:<slug>), else a normalized description
-- (desc:<...>), so a cost entered once auto-prices that item on every future
-- takeoff — the book fills in and compounds with use.
-- ============================================================

create table if not exists public.price_book (
  user_id    uuid not null references auth.users(id) on delete cascade,
  key        text not null,            -- 'mat:<slug>' | 'desc:<normalized>'
  label      text,                     -- human label (last description seen)
  unit       text,                     -- LF | EA | CY | ...
  unit_cost  numeric not null check (unit_cost >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.price_book enable row level security;

drop policy if exists "users own price book" on public.price_book;
create policy "users own price book" on public.price_book
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists price_book_user_idx on public.price_book (user_id);
