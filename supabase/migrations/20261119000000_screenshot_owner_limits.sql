begin;
-- Apply after the existing screenshot admission SQL in docs/sql.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$
begin
  if to_regprocedure('extensions.hmac(bytea,bytea,text)') is null then
    raise exception 'This migration requires pgcrypto in the extensions schema';
  end if;
end;
$$;

create table if not exists public.screenshot_owner_signing (
  singleton boolean primary key default true check (singleton),
  signing_key text not null check (signing_key ~ '^[0-9a-f]{64}$')
);
create table if not exists public.screenshot_owner_attempts (
  user_id uuid not null,
  request_id uuid not null,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  lease_until timestamptz not null,
  primary key (user_id, request_id)
);
alter table public.screenshot_owner_signing enable row level security;
alter table public.screenshot_owner_attempts enable row level security;
revoke all on public.screenshot_owner_signing, public.screenshot_owner_attempts from public, anon, authenticated;

create or replace function public.admit_screenshot_owner(
  p_operation text, p_ip_hash text, p_request_id uuid, p_expires integer, p_signature text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid(); secret text; expected bytea; checked_at timestamptz;
  monthly_count bigint; daily_count bigint; active_count bigint;
begin
  checked_at := clock_timestamp();
  if caller is null or p_operation is null or p_operation not in ('reserve', 'complete')
    or p_request_id is null or p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$'
    or p_signature is null or p_signature !~ '^[0-9a-f]{64}$'
    or p_expires is null or p_expires < floor(extract(epoch from checked_at))
    or p_expires > floor(extract(epoch from checked_at)) + 60 then
    raise exception 'Invalid owner admission proof' using errcode = '42501';
  end if;
  select signing_key into secret from public.screenshot_owner_signing where singleton;
  if secret is null then raise exception 'Owner signing is not configured'; end if;
  expected := extensions.hmac(convert_to(concat_ws(':', 'duedrop-owner-v1', p_operation,
    caller::text, p_request_id::text, p_ip_hash, p_expires::text), 'UTF8'), decode(secret, 'hex'), 'sha256');
  -- Compare hashed MACs so the bytea comparison cannot reveal a matching MAC prefix.
  if sha256(expected) <> sha256(decode(p_signature, 'hex')) then
    raise exception 'Invalid owner admission proof' using errcode = '42501';
  end if;
  if p_operation = 'complete' then
    update public.screenshot_owner_attempts set lease_until = least(lease_until, checked_at)
      where user_id = caller and request_id = p_request_id and ip_hash = p_ip_hash;
    return jsonb_build_object('allowed', true, 'reason', 'allowed', 'retryAfter', 1);
  end if;

  -- Serialize owner admissions independently of regular quotas and recheck AI eligibility.
  perform 1 from public.screenshot_owner_signing where singleton and signing_key = secret for update;
  if not found then raise exception 'Owner signing configuration changed'; end if;
  if not exists (select 1 from public.screenshot_ai_policy
      where singleton and caller = any(allowed_user_ids)) then
    return jsonb_build_object('allowed', false, 'reason', 'account', 'retryAfter', 60);
  end if;
  checked_at := clock_timestamp();
  if p_expires < floor(extract(epoch from checked_at)) then
    raise exception 'Expired owner admission proof' using errcode = '42501';
  end if;
  delete from public.screenshot_owner_attempts where created_at < checked_at - interval '35 days';
  if exists (select 1 from public.screenshot_owner_attempts where user_id = caller and request_id = p_request_id) then
    return jsonb_build_object('allowed', false, 'reason', 'duplicate', 'retryAfter', 60);
  end if;
  select
    count(*) filter (where created_at >= date_trunc('month', checked_at, 'UTC')),
    count(*) filter (where created_at >= date_trunc('day', checked_at, 'UTC')),
    count(*) filter (where lease_until > checked_at)
    into monthly_count, daily_count, active_count from public.screenshot_owner_attempts;
  if monthly_count >= 300 then
    return jsonb_build_object('allowed', false, 'reason', 'monthly', 'retryAfter', 86400);
  end if;
  if daily_count >= 30 then
    return jsonb_build_object('allowed', false, 'reason', 'daily', 'retryAfter',
      greatest(1, ceil(extract(epoch from date_trunc('day', checked_at, 'UTC') + interval '24 hours' - checked_at))::integer));
  end if;
  if active_count >= 1 then
    return jsonb_build_object('allowed', false, 'reason', 'busy', 'retryAfter', 60);
  end if;
  insert into public.screenshot_owner_attempts values (caller, p_request_id, p_ip_hash,
    checked_at, checked_at + interval '60 seconds');
  return jsonb_build_object('allowed', true, 'reason', 'allowed', 'retryAfter', 1);
end;
$$;
revoke all on function public.admit_screenshot_owner(text, text, uuid, integer, text) from public, anon;
grant execute on function public.admit_screenshot_owner(text, text, uuid, integer, text) to authenticated;
commit;
