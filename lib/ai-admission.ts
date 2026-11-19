import { createHmac, randomUUID } from "node:crypto";
import ipaddr from "ipaddr.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./supabase/database.types";
import { HttpError } from "./http";

export type Admission = { allowed: boolean; reason: "allowed" | "account" | "duplicate" | "monthly" | "daily" | "busy" | "ip"; retryAfter: number };
const unavailable = () => new HttpError(503, "Screenshot safeguards are unavailable. Use Manual Entry or contact the app owner.");
export function screenshotRequestId(request: Request) {
  const id = request.headers.get("X-Extraction-Id") ?? randomUUID();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400, "Invalid screenshot request identifier.");
  return id;
}
export function screenshotIpHash(request: Request, secret: string | undefined, environment = { vercel: process.env.VERCEL, nodeEnv: process.env.NODE_ENV }) {
  if (!secret || secret.trim().length < 32) throw unavailable();
  let address: string;
  if (environment.vercel === "1") {
    // Trust only Vercel's platform-supplied address on a Vercel runtime. Never use
    // client-supplied forwarding headers on arbitrary/self-hosted deployments.
    const supplied = request.headers.get("x-vercel-forwarded-for");
    try {
      if (!supplied || supplied.includes(",")) throw new Error();
      const ip = ipaddr.process(supplied.trim());
      if (ip.range() !== "unicast") throw new Error();
      address = ip.toNormalizedString();
    } catch { throw unavailable(); }
  } else if (environment.nodeEnv !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) {
    address = "local-development"; // One conservative bucket, not spoofable X-Forwarded-For.
  } else throw unavailable();
  // Purpose-separated from recovery-cookie signatures; no plaintext IP is stored.
  const key = createHmac("sha256", secret).update("DueDrop screenshot IP key v1").digest();
  return createHmac("sha256", key).update(address).digest("hex");
}
function validAdmission(data: unknown, error: unknown): Admission {
  const slot = data as Partial<Admission> | null;
  const reasons = ["allowed", "account", "duplicate", "monthly", "daily", "busy", "ip"];
  if (error || !slot || typeof slot.allowed !== "boolean" || !reasons.includes(String(slot.reason)) ||
    !Number.isInteger(slot.retryAfter) || Number(slot.retryAfter) < 1 || Number(slot.retryAfter) > 86400 || (slot.allowed !== (slot.reason === "allowed"))) throw unavailable();
  return slot as Admission;
}

export async function reserveScreenshot(supabase: SupabaseClient<Database>, request: Request, secret: string | undefined): Promise<Admission> {
  const { data, error } = await supabase.rpc("reserve_screenshot", { p_ip_hash: screenshotIpHash(request, secret), p_request_id: screenshotRequestId(request) });
  return validAdmission(data, error);
}

export function isScreenshotExempt(verifiedUserId: string, list: string | undefined): boolean {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  return uuid.test(verifiedUserId) && (list ?? "").split(",").some(entry => entry.trim().toLowerCase() === verifiedUserId.toLowerCase());
}

export function ownerScreenshotAccess(supabase: SupabaseClient<Database>, verifiedUserId: string, request: Request) {
  let reservation: { ipHash: string; requestId: string } | undefined;
  async function admit(operation: "reserve" | "complete", ipHash: string, requestId: string) {
    const key = process.env.SCREENSHOT_OWNER_SIGNING_KEY;
    if (!key || !/^[0-9a-f]{64}$/.test(key)) throw unavailable();
    const expires = Math.floor(Date.now() / 1000) + 30;
    const payload = ["duedrop-owner-v1", operation, verifiedUserId.toLowerCase(), requestId, ipHash, expires].join(":");
    const signature = createHmac("sha256", Buffer.from(key, "hex")).update(payload).digest("hex");
    const { data, error } = await supabase.rpc("admit_screenshot_owner", {
      p_operation: operation, p_ip_hash: ipHash, p_request_id: requestId, p_expires: expires, p_signature: signature,
    });
    return validAdmission(data, error);
  }
  return {
    async reserve() {
      const ipHash = screenshotIpHash(request, process.env.AUTH_RECOVERY_SECRET);
      const requestId = screenshotRequestId(request).toLowerCase();
      const admission = await admit("reserve", ipHash, requestId);
      if (admission.allowed) reservation = { ipHash, requestId };
      return admission;
    },
    async complete() {
      if (!reservation) return;
      try { await admit("complete", reservation.ipHash, reservation.requestId); }
      catch { console.warn("Could not release owner screenshot lease. It will expire automatically."); }
    },
  };
}
