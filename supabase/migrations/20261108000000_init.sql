-- Зелёное сукно: схема базы.
-- Таблицы читает и пишет только Edge Function «casino» (прямое подключение к Postgres).
-- Для клиентских ключей anon/authenticated доступ закрыт: RLS включён, политик нет.

create table public.players (
  id          bigint generated always as identity primary key,
  username    text   not null,
  name_key    text   not null unique,          -- имя в нижнем регистре, ё → е
  pass_hash   text   not null,
  balance     bigint not null check (balance >= 0),
  rounds      bigint not null default 0,
  wagered     bigint not null default 0,
  paid        bigint not null default 0,
  biggest     bigint not null default 0,
  refills     bigint not null default 0,
  bj_state    jsonb,                            -- колода и текущая раздача блэкджека
  created_at  timestamptz not null default now()
);

create table public.sessions (
  token_hash  text primary key,                 -- sha256 от токена; сам токен хранится только у игрока
  player_id   bigint not null references public.players(id) on delete cascade,
  expires_at  timestamptz not null
);
create index sessions_by_expiry on public.sessions(expires_at);

create table public.bets (
  id          bigint generated always as identity primary key,
  player_id   bigint not null references public.players(id) on delete cascade,
  game        text   not null check (game in ('slots', 'roulette', 'blackjack')),
  bet         bigint not null,
  win         bigint not null,
  detail      text   not null,
  created_at  timestamptz not null default now()
);
create index bets_by_player on public.bets(player_id, id desc);

create table public.auth_attempts (
  ip          text primary key,
  n           integer not null,
  reset_at    timestamptz not null
);

alter table public.players       enable row level security;
alter table public.sessions      enable row level security;
alter table public.bets          enable row level security;
alter table public.auth_attempts enable row level security;

revoke all on public.players, public.sessions, public.bets, public.auth_attempts from anon, authenticated;
