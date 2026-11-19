begin;
alter table public.tasks add column if not exists course text
  check (course is null or length(btrim(course)) between 1 and 160);
create index if not exists tasks_user_all_day on public.tasks (user_id, due_date) where due_date is not null;

create or replace function public.screenshot_normalized(p_value text) returns text
language sql immutable strict set search_path = '' as $$
  select regexp_replace(btrim(regexp_replace(lower(normalize(p_value, NFKC)),
    '[[:space:]. _:/()!?,–—-]+', ' ', 'g')), '^(problem set|ps) ([0-9]+)$', 'ps\2');
$$;
create or replace function public.screenshot_assignment_links(p_urls text[]) returns text[]
language sql immutable strict set search_path = '' as $$
  select coalesce(array_agg(regexp_replace(lower(parts[1]), '^www\.gradescope\.com$', 'gradescope.com')
    || '/' || parts[2] || '/' || lower(parts[3]) || '/' || parts[4]), '{}')
  from unnest(p_urls) as url
  cross join lateral regexp_match(url,
    '^https://((?:[a-z0-9-]+\.)*instructure\.com|(?:www\.)?gradescope\.com)/courses/([0-9]+)/(assignments|quizzes)/([0-9]+)/?(?:[?#].*)?$', 'i') as parts;
$$;
revoke all on function public.screenshot_normalized(text), public.screenshot_assignment_links(text[]) from public, anon;
grant execute on function public.screenshot_normalized(text), public.screenshot_assignment_links(text[]) to authenticated;

-- Atomic and insert-only. RLS and auth.uid() scope matches and writes to the caller.
create or replace function public.import_screenshot_tasks(p_tasks jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  caller uuid := auth.uid(); incoming record; current_task record; result jsonb := '[]';
  title_key text; course_key text; links text[]; existing_links text[]; existing_course text;
  outcome text;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_tasks is null or jsonb_typeof(p_tasks) <> 'array' then raise exception 'Invalid screenshot batch'; end if;
  if jsonb_array_length(p_tasks) not between 1 and 12 then raise exception 'Invalid screenshot batch size'; end if;
  -- Serialize screenshot imports for this account, including differently keyed retries.
  perform pg_advisory_xact_lock(142927432, hashtext(caller::text));
  for incoming in select * from jsonb_to_recordset(p_tasks) as item(
    id uuid, name text, course text, due_at timestamptz, due_date date, category text, urls text[], allow_possible_duplicate boolean
  ) loop
    if incoming.id is null or incoming.name is null or length(btrim(incoming.name)) not between 1 and 200
      or (incoming.course is not null and length(btrim(incoming.course)) not between 1 and 160)
      or (incoming.due_at is null) = (incoming.due_date is null)
      or not coalesce(incoming.category in ('Homework', 'Applications', 'Job Tasks', 'Other'), false)
      or incoming.urls is null or cardinality(incoming.urls) > 20 or incoming.allow_possible_duplicate is null
      or exists (select 1 from unnest(incoming.urls) as url where url is null or length(url) > 4096 or url !~* '^https?://[^[:space:]]+$')
    then raise exception 'Invalid screenshot task'; end if;
    outcome := 'imported';
    if exists (select 1 from public.tasks where user_id = caller and id = incoming.id::text) then
      outcome := 'already_exists';
    else
      title_key := public.screenshot_normalized(incoming.name);
      course_key := public.screenshot_normalized(coalesce(incoming.course, ''));
      links := public.screenshot_assignment_links(incoming.urls);
      for current_task in select name, course, urls from public.tasks
        where user_id = caller and (due_at = incoming.due_at or due_date = incoming.due_date)
      loop
        existing_links := public.screenshot_assignment_links(current_task.urls);
        if links && existing_links then outcome := 'already_exists'; exit; end if;
        if cardinality(links) > 0 and cardinality(existing_links) > 0 then continue; end if;
        existing_course := public.screenshot_normalized(coalesce(current_task.course, ''));
        if course_key <> '' and existing_course <> '' and course_key <> existing_course then continue; end if;
        if title_key = '' or title_key <> public.screenshot_normalized(current_task.name) then continue; end if;
        if course_key <> '' and existing_course <> '' then outcome := 'already_exists'; exit; end if;
        if not incoming.allow_possible_duplicate then outcome := 'possible_duplicate'; end if;
      end loop;
    end if;
    if outcome = 'imported' then
      insert into public.tasks(user_id, id, name, course, due_at, due_date, category, status, urls, source)
      values(caller, incoming.id::text, btrim(incoming.name), btrim(incoming.course), incoming.due_at,
        incoming.due_date, incoming.category, 'To Do', incoming.urls, 'Manual')
      on conflict (user_id, id) do nothing;
      if not found then outcome := 'already_exists'; end if;
    end if;
    result := result || jsonb_build_array(jsonb_build_object('id', incoming.id, 'status', outcome));
  end loop;
  return result;
end;
$$;
revoke all on function public.import_screenshot_tasks(jsonb) from public, anon;
grant execute on function public.import_screenshot_tasks(jsonb) to authenticated;
commit;
