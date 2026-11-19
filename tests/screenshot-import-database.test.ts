import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isScreenshotExempt, ownerScreenshotAccess, type Admission } from "../lib/ai-admission";
import { screenshotDuplicate, type ScreenshotImportResult } from "../lib/screenshot-batch";
import type { Database } from "../lib/supabase/database.types";
import type { Task } from "../lib/tasks";

const owner = "11111111-1111-4111-8111-111111111111";
const regular = "22222222-2222-4222-8222-222222222222";
const signingKey = "ab".repeat(32);
const db = new PGlite({ extensions: { pgcrypto } });
before(async () => {
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    insert into auth.users values ('${owner}'), ('${regular}');`);
  for (const file of [
    "supabase/migrations/20261006000000_production_tasks.sql",
    "docs/sql/20261109000000_ai_admission_proposal.sql",
    "supabase/migrations/20261119000000_screenshot_owner_limits.sql",
    "supabase/migrations/20261119000001_screenshot_batch_import.sql",
  ]) await db.exec(await readFile(new URL("../" + file, import.meta.url), "utf8"));
  await db.query("insert into public.screenshot_owner_signing(signing_key) values ($1)", [signingKey]);
  await db.query("update public.screenshot_ai_policy set allowed_user_ids=$1::uuid[], global_daily=1", [[owner, regular]]);
});
after(async () => db.close());

async function asUser<T>(id: string | null, action: () => Promise<T>) {
  await db.exec(id ? "set role authenticated" : "set role anon");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ""]);
  try { return await action(); }
  finally { await db.exec("reset role"); }
}

function assignment(name: string, overrides: Record<string, unknown> = {}) {
  return { id: randomUUID(), name, course: "Math 200", due_at: "2026-11-20T06:00:00Z",
    category: "Homework", urls: [], allow_possible_duplicate: false, ...overrides };
}

async function importBatch(rows: unknown[]) {
  return (await db.query<{ result: ScreenshotImportResult[] }>(
    "select public.import_screenshot_tasks($1::jsonb) as result", [JSON.stringify(rows)]
  )).rows[0].result.map(row => row.status);
}

test("batch import detects normalized and source-backed matches without overwriting edits", async () => {
  const first = assignment("PS30");
  const url = "https://www.gradescope.com/courses/25/assignments/83";
  await asUser(owner, async () => {
    assert.deepEqual(await importBatch([
      first, assignment(" Problem Set 30 ", { course: " MATH-200 " }), assignment("PS28"),
      assignment("PS30", { course: "Math 201" }), assignment("PS30", { due_at: "2026-11-21T06:00:00Z" }),
      assignment("Draft", { course: null, urls: [url] }),
      assignment("Renamed Draft", { course: null, urls: [url.replace("www.", "") + "?tracking=1"] }),
      assignment("Draft", { course: null, urls: [url.replace("/83", "/84")] }),
    ]), ["imported", "already_exists", "imported", "imported", "imported", "imported", "already_exists", "imported"]);
    await db.query("update public.tasks set name='My PS30', status='Submitted/Done' where id=$1", [first.id]);
    assert.deepEqual(await importBatch([first]), ["already_exists"]);
    const saved = await db.query("select name,course,status from public.tasks where id=$1", [first.id]);
    assert.deepEqual(saved.rows, [{ name: "My PS30", course: "Math 200", status: "Submitted/Done" }]);
  });
});

test("legacy tasks without courses require confirmation and invalid batches roll back", async () => {
  await asUser(owner, async () => {
    await db.query("insert into public.tasks(user_id,id,name,due_at,category) values (auth.uid(),'legacy','Reading','2026-11-20T06:00:00Z','Homework')");
    const row = assignment(" reading !! ");
    assert.deepEqual(await importBatch([row]), ["possible_duplicate"]);
    assert.deepEqual(await importBatch([{ ...row, allow_possible_duplicate: true }]), ["imported"]);
    assert.deepEqual(await importBatch([{ ...row, allow_possible_duplicate: true }]), ["already_exists"]);
    const valid = assignment("Atomic first row");
    await assert.rejects(importBatch([valid, assignment("Bad category", { category: "Invalid" })]), /Invalid screenshot task/);
    assert.equal((await db.query("select id from public.tasks where id=$1", [valid.id])).rows.length, 0);
  });
});

test("concurrent submissions and different request IDs do not create duplicate imports", async () => {
  await asUser(owner, async () => {
    const row = assignment("Simultaneous submission");
    const results = await Promise.all([
      importBatch([row]), importBatch([row]), importBatch([{ ...row, id: randomUUID() }]),
    ]);
    assert.deepEqual(results.flat().sort(), ["already_exists", "already_exists", "imported"]);
  });
});

test("batch RPC denies unauthenticated callers and never accepts a supplied owner", async () => {
  const row = assignment("Private result");
  await assert.rejects(asUser(null, () => importBatch([row])), /permission denied/);
  await asUser(owner, () => importBatch([row]));
  await asUser(regular, async () => {
    assert.equal((await db.query("select * from public.tasks where id=$1", [row.id])).rows.length, 0);
    assert.deepEqual(await importBatch([{ ...row, user_id: owner }]), ["imported"]);
    assert.deepEqual((await db.query("select user_id from public.tasks where id=$1", [row.id])).rows, [{ user_id: regular }]);
  });
});

test("preview distinguishes exact, uncertain, cross-course and recurring matches", () => {
  const saved: Task = { id: "existing", name: "  PS-30 ", course: "Math 200", dueAt: "2026-11-20T06:00:00Z",
    allDay: false, category: "Homework", status: "To Do", urls: [], source: "Manual" };
  const candidate = { ...saved, name: "problem set 30", id: "new" };
  assert.equal(screenshotDuplicate(candidate, [saved]), "already_exists");
  assert.equal(screenshotDuplicate(candidate, [{ ...saved, course: undefined }]), "possible_duplicate");
  assert.equal(screenshotDuplicate(candidate, [{ ...saved, course: "Math 201" }]), "new");
  assert.equal(screenshotDuplicate(candidate, [{ ...saved, dueAt: "2026-11-21T06:00:00Z" }]), "new");
  assert.equal(screenshotDuplicate({ ...candidate, name: "PS28" }, [saved]), "new");
});

const ip = "a".repeat(64);
async function regularSlot() {
  return (await db.query<{ slot: Admission }>("select public.reserve_screenshot($1,$2) as slot", [ip, randomUUID()])).rows[0].slot;
}
function ownerRpc(actor: string) {
  return { async rpc(_function: string, args: Database["public"]["Functions"]["admit_screenshot_owner"]["Args"]) {
    return asUser(actor, async () => {
      const { p_operation, p_ip_hash, p_request_id, p_expires, p_signature } = args;
      const result = await db.query<{ slot: Admission }>("select public.admit_screenshot_owner($1,$2,$3,$4,$5) as slot",
        [p_operation, p_ip_hash, p_request_id, p_expires, p_signature]);
      return { data: result.rows[0].slot, error: null };
    });
  } } as unknown as SupabaseClient<Database>;
}

test("verified owner has separate audited usage, releases successful work, and keeps a spending ceiling", async () => {
  process.env.SCREENSHOT_OWNER_SIGNING_KEY = signingKey;
  process.env.AUTH_RECOVERY_SECRET = "mocked secret exclusively for the local test";
  const request = new Request("http://127.0.0.1:3000", { headers: { "X-User-Id": regular } });
  assert.equal(isScreenshotExempt(owner, `invalid, ${owner},`), true);
  assert.equal(isScreenshotExempt(regular, owner), false);
  assert.equal(isScreenshotExempt("", owner), false);
  assert.equal((await asUser(regular, regularSlot)).allowed, true);
  assert.equal((await asUser(regular, regularSlot)).reason, "daily");
  for (let index = 0; index < 6; index++) {
    const access = ownerScreenshotAccess(ownerRpc(owner), owner, request);
    assert.equal((await access.reserve()).allowed, true);
    if (!index) assert.equal((await ownerScreenshotAccess(ownerRpc(owner), owner, request).reserve()).reason, "busy");
    await access.complete();
  }
  assert.equal((await db.query("select * from public.screenshot_owner_attempts")).rows.length, 6);
  assert.equal((await db.query("select * from public.screenshot_ai_attempts")).rows.length, 1);
  await db.query(`insert into public.screenshot_owner_attempts
    select $1, gen_random_uuid(), $2, clock_timestamp(), clock_timestamp() from generate_series(1,24)`, [owner, ip]);
  assert.equal((await ownerScreenshotAccess(ownerRpc(owner), owner, request).reserve()).reason, "daily");
});

test("wrong identity, fake signature, missing authentication and replay cannot claim the owner exemption", async () => {
  const id = randomUUID(), expiry = Math.floor(Date.now() / 1000) + 30;
  const proof = createHmac("sha256", Buffer.from(signingKey, "hex"))
    .update(["duedrop-owner-v1", "reserve", owner, id, ip, expiry].join(":")).digest("hex");
  const call = async (signature: string) => (await db.query<{ slot: Admission }>(
    "select public.admit_screenshot_owner('reserve',$1,$2,$3,$4) as slot", [ip, id, expiry, signature]
  )).rows[0].slot;
  await assert.rejects(asUser(null, () => call(proof)), /permission denied/);
  await assert.rejects(asUser(regular, () => call(proof)), /Invalid owner admission proof/);
  await assert.rejects(asUser(owner, () => call("0".repeat(64))), /Invalid owner admission proof/);
  await assert.rejects(asUser(regular, () => db.query("select signing_key from public.screenshot_owner_signing")), /permission denied/);
  await db.exec("truncate public.screenshot_owner_attempts");
  assert.equal((await asUser(owner, () => call(proof))).allowed, true);
  assert.equal((await asUser(owner, () => call(proof))).reason, "duplicate");
});
