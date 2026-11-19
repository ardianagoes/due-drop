import { apiError, reply, requireUser } from "@/lib/api";
import { MAX_SCREENSHOT_ASSIGNMENTS } from "@/lib/assignment-draft";
import { assertSameOrigin, HttpError, readJson } from "@/lib/http";
import { isScreenshotImportItem, isScreenshotImportResult } from "@/lib/screenshot-batch";
import { toTaskRow } from "@/lib/task-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { supabase, user } = await requireUser();
    const batch = await readJson(request, 1_100_000);
    if (!Array.isArray(batch) || batch.length < 1 || batch.length > MAX_SCREENSHOT_ASSIGNMENTS ||
      !batch.every(isScreenshotImportItem) || new Set(batch.map(item => item.task.id.toLowerCase())).size !== batch.length) {
      throw new HttpError(400, "Select valid, reviewed assignments to import.");
    }
    const { data, error } = await supabase.rpc("import_screenshot_tasks", {
      p_tasks: batch.map(({ task, allowPossibleDuplicate }) => {
        const row = toTaskRow(task, user.id);
        return { id: row.id.toLowerCase(), name: row.name, course: row.course ?? null,
          due_at: row.due_at, due_date: row.due_date, category: row.category, urls: row.urls,
          allow_possible_duplicate: allowPossibleDuplicate };
      }),
    });
    if (error?.code === "PGRST202" || error?.code === "42883") {
      throw new HttpError(503, "Screenshot import is unavailable until the Supabase batch migration is applied. Manual Entry is available.");
    }
    if (error) throw new HttpError(500, "Could not import these assignments. Your review is still available to retry.");
    if (!Array.isArray(data) || data.length !== batch.length || !data.every(isScreenshotImportResult)) {
      throw new HttpError(500, "Could not confirm the screenshot import. Try again.");
    }
    return reply({ results: data });
  } catch (error) {
    return apiError(error);
  }
}
