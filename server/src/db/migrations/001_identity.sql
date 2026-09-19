-- 001_identity.sql — hesap kimliği.
-- Spec: docs/superpowers/specs/2026-09-19-cok-oyunculu-kabuk-tasarim.md §2, §6

create extension if not exists pgcrypto;

create table if not exists users (
  id             uuid        primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  gold           integer     not null default 0,
  rank_points    integer     not null default 0,
  country_code   char(2),
  region         text,
  nickname_base  text        not null,
  nickname_tag   text        not null,

  constraint users_nickname_unique unique (nickname_base, nickname_tag),
  constraint users_region_check check (
    region is null or region in ('EU','NA','LATAM','MENA','APAC','SEA','OCE')
  ),
  constraint users_gold_check check (gold >= 0),
  -- Yalnızca rakam. Genişlik uygulamada zorlanır (varsayılan 4, dolunca artar);
  -- şema testlerin daralttığı genişlikleri de kabul edebilmek için serbesttir.
  constraint users_tag_check check (nickname_tag ~ '^[0-9]+$')
);

-- Aynı taban için boş hane taraması bu indeksi kullanır.
create index if not exists users_nickname_base_idx on users (nickname_base);

create table if not exists auth_identities (
  user_id       uuid        not null references users(id) on delete cascade,
  provider      text        not null,
  provider_uid  text        not null,
  email_hash    text,
  password_hash text,
  created_at    timestamptz not null default now(),

  primary key (provider, provider_uid),
  constraint auth_provider_check check (
    provider in ('google','apple','facebook','password')
  ),
  -- Şifre özeti yalnızca password sağlayıcısında olur, orada da zorunludur.
  constraint auth_password_hash_check check (
    (provider = 'password' and password_hash is not null)
    or (provider <> 'password' and password_hash is null)
  )
);

create index if not exists auth_identities_user_idx  on auth_identities (user_id);
-- Hesap birleştirme e-posta özetinden yapılır (ham e-posta saklanmaz).
create index if not exists auth_identities_email_idx on auth_identities (email_hash)
  where email_hash is not null;
