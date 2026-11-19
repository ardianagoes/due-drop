# DueDrop development and operations

Use this guide for detailed setup; the README is the short project overview.

## Local setup

Use Node.js 22+ and `npm ci`. For a fresh checkout only, copy `.env.example` to
`.env.local`; edit an existing file instead of overwriting configured credentials.
Windows PowerShell users can use `npm.cmd` if execution policy blocks `npm.ps1`.

Use the existing Supabase project. For a new project only, review and apply
`supabase/migrations/20261006000000_production_tasks.sql`. It owns the task schema,
RLS policies, atomic imports, browser-backup receipts and durable import limiter.
Do not re-create tables or rename historical migrations for the rebrand.

Configure email authentication following [EMAIL_AUTH_SETUP.md](EMAIL_AUTH_SETUP.md).
Then run `npm run dev` and open `http://127.0.0.1:3000`. Use the same hostname
throughout: `localhost` and `127.0.0.1` have different cookie origins.

## Environment

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Existing Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Existing publishable key, not a service-role/secret key |
| `NEXT_PUBLIC_APP_URL` | Exact browser origin; local HTTP or canonical production HTTPS |
| `AUTH_RECOVERY_SECRET` | Server-only random value, at least 32 characters; keep stable |
| `APP_TIMEZONE` | Relative screenshot dates, floating ICS times and Canvas cutoff; defaults to `America/New_York` |
| `ICS_ALLOWED_HOSTS` | Optional comma-separated exact feed hostnames, such as your school host |
| `SCREENSHOT_AI_ENABLED` | Server-only paid-feature gate; defaults to disabled; only exact `true` enables admission checks |
| `OPENAI_API_KEY` | Optional server-only project key; never put it in a public variable |
| `OPENAI_IMAGE_MODEL` | Existing configurable image model; default remains `gpt-5.4-mini` |

No service-role key or database password belongs in this app. Public variables
are built into browser assets, so changing them requires a redeploy. Keep secrets
out of Git, command output, screenshots and shared request logs.

`AUTH_RECOVERY_SECRET` also derives a separate HMAC key for pseudonymous AI IP
rate-limit buckets. Recovery-cookie signatures themselves are unchanged. No new
secret is generated or rotated by this PR. Rotation invalidates recovery grants
and changes IP buckets; account/global attempt totals remain in the database.

## Canonical production origin: operator approval required

The verified live URL is `https://due-drop.vercel.app`. The former
`https://brown-task-planner.vercel.app` currently redirects there. Read-only checks
on November 9 found DueDrop auth callbacks redirecting back to the former host,
indicating stale canonical-origin configuration. This can cause valid browser
mutations to fail strict Origin checks after the domain redirect.

Review and approve `NEXT_PUBLIC_APP_URL=https://due-drop.vercel.app` in the
existing Vercel Production environment, the matching Supabase Site URL/allowlist
and the templates in the auth guide. Configure previews separately; do not loosen
Origin checks or use a wildcard production allowlist. Redeploy only after approval.
The code does not change hosted URLs, projects, accounts or auth settings.

## Optional paid screenshot analysis

Analysis is paused by default, even if an OpenAI key already exists. Manual entry,
task management and ICS imports still work. The existing screenshot interface,
local preview, explicit Analyze click and editable confirmation remain available;
a paused/failed analysis can still be corrected manually.

The server passes only the enabled/disabled boolean to the dashboard, never the
key or secret. When off, the screenshot tab shows a disabled-analysis notice and
disabled action before any attempt; paste/upload remains a local preview. Its
Use Manual Entry shortcut focuses the manual tab, where normal validation and
explicit saving remain available. The API independently enforces the same flag.

Before enabling paid work, approve the provider controls and SQL proposal described
in [SECURITY.md](SECURITY.md). The proposal is deliberately outside
`supabase/migrations/` and is not run by any app/build script. With no proposal,
empty allowlist, unavailable limiter, invalid IP attribution or missing secret,
the endpoint fails closed before reading/decoding the image or calling OpenAI.

Admission uses the verified account and private database policy. Default bounds
are 20 attempts globally per UTC day, 100 globally per UTC month, 5 per account per
UTC day, 3 per IP per ten minutes, 2 global 60-second admission leases and 1 lease
per account. These are request counts, not dollar budgets. Failed/cancelled
admitted attempts are not refunded. Per-user import limits also remain in place.

Vercel IP attribution uses its `x-vercel-forwarded-for` header only in a Vercel
runtime. The address is normalized and HMAC-hashed before storage. Arbitrary
self-hosted production requests fail closed rather than trusting spoofable
headers. Local development uses one conservative shared bucket. IP limits do not
identify people reliably: campus NATs share addresses and IPv6/proxy addresses can
rotate. Account approval and shared quotas remain the stronger controls.

`X-Extraction-Id` is an optional UUID header for replay protection. The UI sends
one per explicit analysis; callers omitting it retain compatibility but receive
the same account/global caps. A duplicate ID returns 409, without another paid
request. Results are not cached in the limiter. Explicit new analyses have new
IDs; replay protection is not image-content deduplication.

Uploads remain one static PNG/JPEG/WebP, at most 3 MB and 16 million decoded pixels.
Images normalize to JPEG within 2048×2048 without enlarging, stripping metadata.
Upload reads time out at ten seconds, image conversion at five, and provider work
at twenty; the route budget stays 45 seconds. Client cancellation also aborts the
outbound request, but a provider may still charge for work already accepted.
One admission makes at most one Responses request with strict JSON, no tools or
automatic retries, `store:false`, reasoning `none`, and up to 4,400 output tokens
for up to 12 assignment candidates. The larger output ceiling accommodates batch
results. For a longer list, crop remaining rows into another screenshot.

Only explicitly confirmed task fields are saved. The screenshot import endpoint
sends one insert-only transaction to Supabase. Manual entry still uses its existing API.
Screenshots, prompts, provider output, feed tokens and plaintext IPs are not stored
in the new limiter. It keeps account/request UUIDs, HMAC IP buckets and timestamps
and prunes records older than 35 days on approved admission attempts. An inactive
project retains older records until its next approved attempt or owner cleanup;
there is no scheduled retention job. It does not use account deletion cascades,
because deleting an account must not reset the global quota.

### Screenshot batch migration and optional owner exemption

1. Apply `supabase/migrations/20261119000001_screenshot_batch_import.sql` after
   the existing production task migration. It adds an optional course field and
   an authenticated insert-only RPC. Apply it before using the updated screenshot
   review, including single-assignment saves. If merging to main starts a Vercel
   production deployment, run the SQL in the matching Supabase project's SQL
   Editor before merging. No task backfill is needed.
2. Leave `RATE_LIMIT_EXEMPT_USER_IDS` empty to keep every account on the regular
   limiter. To set up an exemption, first verify the existing AI admission SQL
   in `docs/sql` is installed. Then apply
   `supabase/migrations/20261119000000_screenshot_owner_limits.sql`. It uses
   `pgcrypto` in the Supabase `extensions` schema. If the extension is installed
   elsewhere, review its location with the project owner before proceeding.
3. In the intended Vercel environment, set server-only `RATE_LIMIT_EXEMPT_USER_IDS`
   to the comma-separated User UUIDs copied from Supabase **Authentication → Users**.
   Use only your trusted owner UUID for a personal exemption. The UUID must also
   be in the existing private `screenshot_ai_policy.allowed_user_ids` AI allowlist.
4. For that same environment, create a dedicated 32-byte random signing key
   (`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`).
   Set it as server-only `SCREENSHOT_OWNER_SIGNING_KEY` in Vercel. Using an approved
   admin connection, insert the same 64-character lowercase hex value into
   `public.screenshot_owner_signing.signing_key` for `singleton = true`. Use a
   bound parameter where available and keep the value out of version control,
   browser variables and shared logs. No service-role key is needed. Keep existing
   secrets as-is. Leave paid AI disabled unless it has already been separately approved.

Verify which functions are installed in **Supabase → SQL Editor**:

```sql
select
  to_regprocedure('public.import_screenshot_tasks(jsonb)') is not null as batch_ready,
  to_regprocedure('public.reserve_screenshot(text,uuid)') is not null as regular_ai_ready,
  to_regprocedure('public.admit_screenshot_owner(text,text,uuid,integer,text)') is not null as owner_rpc_ready;
```

`batch_ready` is required for screenshot saves. For the exemption, confirm all
three are true and check the owner UUID in the private policy. If the owner is
missing, add only that UUID and keep the other approved accounts:

```sql
update public.screenshot_ai_policy
set allowed_user_ids = array_append(allowed_user_ids, 'YOUR_SUPABASE_USER_UUID'::uuid)
where singleton
  and array_position(allowed_user_ids, 'YOUR_SUPABASE_USER_UUID'::uuid) is null;
```

Use the existing Vercel project's **Settings → Environment Variables** to add the
two server-only owner variables to the intended environment. A new deployment must
read the updated values. Avoid putting your owner signing key in SQL Editor
history. With project-owner access, add the singleton row through **Supabase →
Table Editor → screenshot_owner_signing** or an admin client using a bound
parameter. Set `singleton = true` and `signing_key` to the exact Vercel value.

The verified owner bypasses the normal screenshot and legacy shared import bucket
for screenshot analysis. Calendar imports still use their original limits.
The owner ledger separately counts every admitted attempt and stores account and
request UUIDs, a hashed IP and lease timestamps. It enforces 30 attempts per UTC
day and 300 per UTC month across exempt accounts, with one active owner analysis.
A successful analysis releases its lease immediately. Failed or cancelled work
keeps the lease until expiry (up to 60 seconds) because the provider may still
be processing it. These limits count requests. Maintain provider project spend
limits, alerts and rate limits for dollar exposure.

For duplicate matching, recognized Canvas or Gradescope assignment links are
compared at the same deadline. Otherwise a normalized title, known matching course
and exact deadline can confirm a duplicate. A same-title, same-deadline match
without a course requires review. Older manual and feed tasks may not have course
metadata. Existing tasks and their edits are preserved. On retry, the same reviewed
rows retain their IDs, and Supabase serializes duplicate checks for each account.

Manual staging checklist:

- With paid analysis off, verify Manual Entry still saves and screenshot previews
  stay local. Exercise extraction with a mock or an explicitly approved test account.
- Review a screenshot with PS28, PS30 and PS31, including two rows with the same due
  time. Confirm each title stays paired with its own deadline and optional course.
- Edit a missing or ambiguous date, confirm the correction, select the row, and
  import the batch. Reimport the same batch and check the existing tasks remain intact.
- Verify a second account cannot see the first account's tasks. If testing the owner
  setting, verify the regular user retains normal limits and the owner's attempts
  appear only in the private owner ledger.

## Calendar feeds and task compatibility

Canvas and Gradescope require an actual ICS subscription URL. Built-in hosts are
`instructure.com` and `gradescope.com` with subdomains; additional school hosts must
be explicitly listed. The custom HTTPS downloader still pins public DNS answers,
verifies TLS hostnames, rejects redirects/non-200s and limits responses to 2 MB.
Its twelve-second total deadline now includes DNS resolution. It sends the
required explicit User-Agent. No private feed URL is retained in task storage.

Imports remain ten attempts per account per ten minutes, including failed
downloads. Canvas ignores new past calendar dates using `APP_TIMEZONE`, preserving
existing history and status/category. Gradescope behavior and all-day/timed date
semantics remain unchanged. Recurring series are skipped rather than expanded.

The compatibility identifiers `deadline-desk.tasks.v1`,
`deadline-desk.migration-owner.v1`, `deadline-desk.migration-key.v1`, `dd-email-link`
and `dd-recovery` intentionally retain their old names. Changing them could lose
browser-backup access or interrupt authentication. Task types, existing SQL and
API request/response bodies retain their contracts.

## Checks and repository organization

```sh
npm run typecheck
npm test
npm run build
npm run check:branding
npm audit
# With the local app running separately:
npm run test:smoke
```

Tests use mocked Auth/OpenAI responses and local PGlite databases. They do not
send paid requests or operate real accounts. For deployment sign-off, manually
check login/recovery, two-account task isolation, CRUD/status/calendar views and
a personal ICS import using the approved production configuration.

The source is at repository root. `app/` holds pages/API handlers, `components/`
the UI, `lib/` validation/storage/security helpers, `supabase/migrations/` existing
production SQL, `tests/` local verification, and `docs/` detailed operator guidance.
Historical records remain in `VERIFICATION.md` and `docs/UI_REDESIGN.md` with their
original names/dates. They are not current deployment instructions.

Keep the existing D/check icon. Edit `app/icon.svg`, then run
`node scripts/generate-icons.cjs` to regenerate its favicon/Apple/PNG variants.
The new SVG title is DueDrop; its rendered geometry and colors are unchanged.

No GitHub Actions workflow or license was present during review. A public repo
does not by itself grant an open-source license. The owner should choose a license
deliberately and can add a concise About description. Do not add a license, rename
the repository, or grant Actions write permissions just to tidy the project.
