# DueDrop security review · November 21, 2026

Reviewed `main` at `17f8e93`, including the merged screenshot batch and owner
changes. The review used repository source, local tests, public deployment
metadata, and unauthenticated HTTP probes. Hosted dashboards and authenticated
production data were outside the available evidence.

## Confirmed findings

| Severity | Finding | Evidence and disposition |
| --- | --- | --- |
| Medium | Screenshot type validation occurred after native image parsing began. | At baseline, [image-upload.ts:25](https://github.com/ardianagoes/due-drop/blob/17f8e93/lib/image-upload.ts#L25) passed bytes to Sharp and opened metadata before comparing the actual format with the claimed MIME type. The local regression observed two native metadata calls for mislabeled fixtures. [The fix](../lib/image-upload.ts#L7) checks PNG, JPEG, or WebP signatures against the declared type before Sharp receives the bytes. Existing decode, pixel, page, size, conversion timeout and metadata stripping checks remain. No native code execution or compromise was observed. |
| Low | Calendar parser warnings can send raw ICS field values to server logs. | [ics.ts:23](../lib/ics.ts#L23) invokes `node-ical`. A synthetic event with a malformed duration parsed as a calendar event while the dependency logged its original invalid value. The parser also includes raw UIDs and some other values in warning strings. A disclosure of real calendar data was not verified. This remains open. The library writes directly to the process console. Prefer upstream redaction or a separately validated parser isolation change over muting logs for concurrent requests. |
| Medium, availability | An already-approved regular AI user can consume the shared request budget through the authenticated reservation RPC. | The [regular admission SQL](sql/20261109000000_ai_admission_proposal.sql#L31) exposes reservation to authenticated clients and then checks the private allowlist. A successful reservation increments counts before any provider call. A caller can therefore consume request capacity without paying OpenAI. This does not elevate an account, expose tasks, or give access to the separate owner ledger. Keep the regular allowlist limited to trusted users. Changing this boundary requires approval and a separate SQL rollout. |

No critical or high-severity vulnerability, exposed credential, cross-account
task access, or owner impersonation was confirmed in the reviewed scope.

## Authentication and ownership

- The dashboard and private APIs verify the Supabase user server-side at
  [app/page.tsx:10](../app/page.tsx#L10) and [api.ts:10](../lib/api.ts#L10).
  Proxy refresh is separate from route authorization. Mutations check the exact
  configured Origin at [http.ts:11](../lib/http.ts#L11). The repository has no
  Server Actions or cross-origin credential sharing configured.
- [Task RLS](../supabase/migrations/20261006000000_production_tasks.sql#L18)
  independently limits reads, inserts, updates and deletes to the authenticated
  owner. The [screenshot batch RPC](../supabase/migrations/20261119000001_screenshot_batch_import.sql#L23)
  is SECURITY INVOKER, derives `auth.uid()`, and uses an insert-only transaction.
  Existing regression tests exercise separate users and repeated imports.
- [The extraction route](../app/api/tasks/extract-image/route.ts#L8) chooses
  owner access only after verifying the session and checking the server UUID
  list. The [owner RPC](../supabase/migrations/20261119000000_screenshot_owner_limits.sql#L28)
  requires an expiring proof bound to operation, authenticated UUID, request
  UUID and hashed IP. Its key and ledger are private under SQL grants and RLS.
  Local tests reject anonymous callers, mismatched identities, fake proofs and
  replayed reservations. The patch leaves owner access and quotas intact.
- [Recovery](../lib/auth-handlers.ts#L18) uses a nonce, fixed redirects and
  provider verification. Password updates require a session-bound signed grant
  through [auth-flow.ts](../lib/auth-flow.ts#L90). Auth diagnostics whitelist
  error codes. Supabase policy settings for signups, MFA, password compromise
  checks and email delivery require a hosted dashboard review.

## Files, external requests and billing

- DueDrop keeps screenshot previews in browser memory and sends the chosen
  upload to one extraction route. No application screenshot bucket, file path,
  or stored image URL was identified. Uploads are size constrained, resized and
  converted in memory. Only selected task fields persist. OpenAI receives the
  normalized image when AI runs. Review provider retention independently of
  the request's `store: false` option.
- The [OpenAI integration](../lib/openai-image.ts#L40) uses a fixed HTTPS
  endpoint without redirects. It makes one request per admitted attempt, caps
  response size and generation, and uses an abort deadline. Screenshot text
  is untrusted. Model output is validated and shown for review. The provider
  call has no tools, no task-write permission, and no ability to visit URLs
  extracted from the screenshot. Screenshot text and URL labels render as
  React text, with HTTP(S)-only external links.
- [Calendar egress](../lib/feed-fetch.ts#L7) limits destination hosts, rejects
  private DNS answers, pins the validated address, verifies TLS, rejects
  redirects and caps download size and time. Feed URLs do not enter the
  application task database. Parser CPU isolation and the warning issue above
  remain separate from downloader controls.
- `POST /api/tasks/extract-image` is the only application OpenAI billing path.
  Supabase requests, authentication email, serverless execution and calendar
  egress can still consume provider plan resources. AI requires the literal
  server flag `SCREENSHOT_AI_ENABLED=true`, a configured key, verified
  authentication and a successful admission. Local regression tests check
  that disabled or rejected requests invoke neither image processing nor AI.
  Public production checks alone cannot establish the live flag value.
- Regular defaults are 20 attempts per UTC day and 100 per UTC month across
  regular accounts. The separate owner ledger allows 30 per UTC day and 300
  per UTC month, one active owner analysis at a time. These are app request
  counts. Provider spend alerts send notices while traffic continues. An
  enforced provider project or organization limit can stop affected calls,
  with possible propagation lag. Verify settings for the project used by
  DueDrop and any preview environments with separate provider credentials.
  [OpenAI spend limits](https://developers.openai.com/api/docs/guides/spend-limits)

## Repository and deployment evidence

- The history scan covered 32 commits from local refs and reflogs, 295 distinct
  blobs including seven unreachable blobs, and 292 text blobs. Previously
  deleted files were included. No high-confidence private key, API key,
  privileged JWT, credential URL, or private feed token matched. No sensitive
  environment or deployment-linkage file appeared in tracked history. This is
  a pattern scan. Unknown formats, binary-embedded secrets, other clones and
  provider logs were outside its coverage.
- Reviewed package declarations, lockfile and available scripts. Both full and
  production-only npm audits reported zero advisories at review time. No
  GitHub Actions workflow or `vercel.json` was found at HEAD or in scanned
  ref history. Public GitHub status shows Vercel integration. Repository-level
  branch protection, Actions settings and secret scanning policy were not
  accessible.
- On the public DueDrop domain, signed-out task access returned 401 and
  `private, no-store`. Login and auth callbacks used no-referrer. Callbacks
  remained on the current canonical domain, and the legacy domain redirected
  there. The login HTML and its eight referenced public browser scripts had
  no high-confidence credential match. The visible Supabase key was
  publishable. Authenticated production chunks, server files and provider
  settings were not accessible.
- Twelve deployment-specific Vercel URLs from public GitHub deployment
  records, including current, old and preview builds, redirected signed-out
  probes to Vercel sign-in. Their internal configuration was not inspected.
  This sample does not establish protection for every deployment or alias.
- The browser receives the value named
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Putting an elevated key in that
  variable would disclose it in build output. The scanned public build did
  not contain an elevated key. Verify the corresponding preview and
  production vars in Vercel as a deployment check.

## Deployment and verification

This change requires no migration, environment change, account action, quota
change or infrastructure change. Review this PR, then verify on a protected
test environment that sign-in, task creation and editing, calendar imports,
and screenshot review still work. Confirm a normal PNG, JPEG or WebP works
and an unsupported file is rejected. If checking extraction against OpenAI
in a hosted environment, use an intentionally approved budget and one
test screenshot. Review existing runtime log access and retention for the
calendar warning gap before widening feed access.

The new test at [image-extraction.test.ts:181](../tests/image-extraction.test.ts#L181)
failed on baseline behavior and passed with the new preflight check. Existing
tests cover owner identity, quotas, replay, RLS, auth recovery, downloader
limits, screenshot processing, editing and batch importing. All provider
responses used in tests were mocked or avoided.

Final checks passed: 127 automated tests, TypeScript, production build,
branding, live local signed-out route and Origin checks, and whitespace review.
The local production build used synthetic OpenAI and signing credentials plus
a fake exempt UUID. None of those values appeared in the 37 browser assets
scanned. No hosted deployment, key, database, auth policy, or billing setting
was changed during this review.
