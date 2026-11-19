import { isTask, type Task } from "./tasks";

export type DuplicateStatus = "new" | "already_exists" | "possible_duplicate";
export type ScreenshotImportItem = { task: Task; allowPossibleDuplicate: boolean };
export type ScreenshotImportResult = { id: string; status: Exclude<DuplicateStatus, "new"> | "imported" };

// Keep these narrowly scoped rules in sync with the screenshot import migration.
function normalized(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[\s._:/()!?,–—-]+/gu, " ").trim()
    .replace(/^(?:problem set|ps) ([0-9]+)$/u, "ps$1");
}

function assignmentLinks(urls: string[]) {
  return urls.flatMap(url => {
    const match = /^https:\/\/((?:[a-z0-9-]+\.)*instructure\.com|(?:www\.)?gradescope\.com)\/courses\/([0-9]+)\/(assignments|quizzes)\/([0-9]+)\/?(?:[?#].*)?$/i.exec(url);
    return match ? [match[1].toLowerCase().replace(/^www\.gradescope\.com$/, "gradescope.com") + "/" + match.slice(2).join("/").toLowerCase()] : [];
  });
}

export function screenshotDuplicate(task: Task, others: readonly Task[]): DuplicateStatus {
  const title = normalized(task.name);
  const course = normalized(task.course ?? "");
  const links = assignmentLinks(task.urls);
  let status: DuplicateStatus = "new";
  for (const other of others) {
    if (task.id === other.id) return "already_exists";
    const sameDeadline = task.allDay === other.allDay && (task.allDay
      ? task.dueAt === other.dueAt : Date.parse(task.dueAt) === Date.parse(other.dueAt));
    if (!sameDeadline) continue;
    const otherLinks = assignmentLinks(other.urls);
    if (links.some(link => otherLinks.includes(link))) return "already_exists";
    if (links.length && otherLinks.length) continue;
    const otherCourse = normalized(other.course ?? "");
    if (course && otherCourse && course !== otherCourse) continue;
    if (!title || title !== normalized(other.name)) continue;
    if (course && otherCourse) return "already_exists";
    status = "possible_duplicate";
  }
  return status;
}

export function isScreenshotImportItem(value: unknown): value is ScreenshotImportItem {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ScreenshotImportItem>;
  return Object.keys(entry).length === 2 && isTask(entry.task) &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.task.id) &&
    entry.task.source === "Manual" && entry.task.status === "To Do" &&
    typeof entry.allowPossibleDuplicate === "boolean";
}

export function isScreenshotImportResult(value: unknown): value is ScreenshotImportResult {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ScreenshotImportResult>;
  return typeof entry.id === "string" &&
    (entry.status === "imported" || entry.status === "already_exists" || entry.status === "possible_duplicate");
}
