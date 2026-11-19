"use client";

import { useRef, useState, type FormEvent } from "react";
import { draftFromCandidate, taskFromDraft, type AssignmentDraft, type Extraction } from "@/lib/assignment-draft";
import { screenshotDuplicate, type ScreenshotImportItem, type ScreenshotImportResult } from "@/lib/screenshot-batch";
import type { Task } from "@/lib/tasks";
import TaskReviewFields from "./task-review-form";

type Row = {
  id: string;
  draft: AssignmentDraft;
  selected: boolean;
  reviewed: boolean;
  allowPossibleDuplicate: boolean;
  result?: ScreenshotImportResult["status"];
};

function reviewedTask(row: Row): Task | null {
  try { return taskFromDraft(row.draft, row.id); }
  catch { return null; }
}

function classify(rows: Row[], tasks: readonly Task[], extraction: Extraction) {
  const preceding = [...tasks];
  return rows.map((row, index) => {
    const task = reviewedTask(row);
    const duplicate = row.result === "already_exists" ? "already_exists"
      : row.result === "possible_duplicate" ? "possible_duplicate"
      : task ? screenshotDuplicate(task, preceding) : "new";
    const needsReview = !task || (extraction.candidates[index].uncertainFields.length > 0 && !row.reviewed);
    if (task && !needsReview && row.result !== "already_exists" && duplicate !== "already_exists") preceding.push(task);
    return { task, duplicate, needsReview };
  });
}

export default function ScreenshotReview({ extraction, tasks, disabled, onImport, onTryAgain }: {
  extraction: Extraction;
  tasks: readonly Task[];
  disabled: boolean;
  onImport: (items: ScreenshotImportItem[]) => Promise<ScreenshotImportResult[]>;
  onTryAgain: () => void;
}) {
  const single = extraction.candidates.length === 1;
  const [rows, setRows] = useState<Row[]>(() => {
    const initial = extraction.candidates.map(candidate => ({
      id: crypto.randomUUID(), draft: draftFromCandidate(candidate, extraction.referenceTimezone),
      selected: false, reviewed: false, allowPossibleDuplicate: false,
    }));
    const evaluations = classify(initial, tasks, extraction);
    return initial.map((row, index) => ({
      ...row, selected: !evaluations[index].needsReview && evaluations[index].duplicate === "new",
    }));
  });
  const [error, setError] = useState("");
  const [hasImported, setHasImported] = useState(false);
  const submitting = useRef(false);
  const evaluations = classify(rows, tasks, extraction);
  const canSelect = (index: number) => {
    const row = rows[index], evaluation = evaluations[index];
    return row.result !== "imported" && evaluation.duplicate !== "already_exists" && !evaluation.needsReview &&
      (evaluation.duplicate !== "possible_duplicate" || row.allowPossibleDuplicate);
  };

  function update(index: number, patch: Partial<Row>) {
    setError("");
    setRows(previous => previous.map((row, position) => index === position ? { ...row, ...patch } : row));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || submitting.current) return;
    setError("");
    const selected = rows.flatMap((row, index) => (single || row.selected) && canSelect(index)
      ? [{ task: evaluations[index].task!, allowPossibleDuplicate: row.allowPossibleDuplicate }] : []);
    if (!selected.length) {
      setError(single && evaluations[0].needsReview
        ? "Confirm the uncertain details and enter a valid deadline before saving."
        : "Select a reviewed assignment to import.");
      return;
    }
    submitting.current = true;
    try {
      const results = await onImport(selected);
      const byId = new Map(results.map(result => [result.id, result.status]));
      setHasImported(true);
      setRows(previous => previous.map(row => {
        const result = byId.get(row.id);
        return result ? { ...row, result, selected: false, allowPossibleDuplicate: false } : row;
      }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not import the selected assignments.");
    } finally { submitting.current = false; }
  }

  const imported = rows.filter(row => row.result === "imported").length;
  const alreadyExists = evaluations.filter((evaluation, index) => rows[index].result !== "imported" && evaluation.duplicate === "already_exists").length;
  const needsReview = evaluations.filter((evaluation, index) => rows[index].result !== "imported" &&
    evaluation.duplicate !== "already_exists" && (evaluation.needsReview || evaluation.duplicate === "possible_duplicate")).length;
  const notSelected = rows.length - imported - alreadyExists - needsReview;
  return <form noValidate onSubmit={submit} aria-label="Review detected assignments" className="mt-4 space-y-3 text-sm text-slate-300">
    <h3 className="font-semibold text-slate-100">{single ? "Review assignment before saving" : "Review detected assignments"}</h3>
    <fieldset disabled={disabled} className="space-y-3 disabled:opacity-60">
      {rows.map((row, index) => {
        const candidate = extraction.candidates[index];
        const { duplicate, needsReview } = evaluations[index];
        const imported = row.result === "imported";
        const label = imported ? "Imported" : duplicate === "already_exists" ? "Already exists"
          : duplicate === "possible_duplicate" ? "Possible duplicate" : needsReview ? "Needs review" : "New";
        const name = row.draft.name.trim() || "Untitled assignment";
        const fields = <div className="mt-3 space-y-3">
          <TaskReviewFields candidate={candidate} draft={row.draft} required={single} update={patch => update(index, {
            draft: { ...row.draft, ...patch }, reviewed: false, selected: false, allowPossibleDuplicate: false, result: undefined,
          })} />
          {candidate.uncertainFields.length > 0 && <label className="flex items-start gap-2 text-xs text-amber-200">
            <input type="checkbox" required={single} checked={row.reviewed} onChange={event => update(index, {
              reviewed: event.target.checked, selected: false,
            })} />I checked and corrected the uncertain details.</label>}
          {duplicate === "possible_duplicate" && <label className="flex items-start gap-2 text-xs text-amber-200">
            <input type="checkbox" required={single} checked={row.allowPossibleDuplicate} onChange={event => update(index, {
              allowPossibleDuplicate: event.target.checked, selected: false,
            })} />A similar task name and deadline exists. I checked that this is a different assignment.</label>}
        </div>;
        return <div key={row.id} className="rounded-lg border border-slate-700 p-3">
          <div className="flex items-start gap-3">
            {!single && <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-blue-500" aria-label={`Select ${name}`}
              disabled={!canSelect(index)} checked={row.selected && canSelect(index)}
              onChange={event => update(index, { selected: event.target.checked })} />}
            <div className="min-w-0 flex-1">
              <p className="break-words font-medium text-slate-100">{name}</p>
              <p className="break-words text-xs text-slate-400">
                {row.draft.course?.trim() || "Course unspecified"} · {row.draft.dueDate || "Date unspecified"} · {row.draft.allDay ? "All day" : row.draft.dueTime || "Time unspecified"}
                {!row.draft.allDay && row.draft.dueTime && ` (${row.draft.timezone})`}
              </p>
            </div>
            <span className="shrink-0 text-xs text-amber-200">{label}</span>
          </div>
          {!imported && (single ? fields : <details className="mt-2">
            <summary className="cursor-pointer text-xs text-slate-300">Review or edit {name}</summary>{fields}
          </details>)}
        </div>;
      })}
      <div className="flex flex-wrap gap-2">
        {!single && <button type="button" className="button-secondary" onClick={() => setRows(previous =>
          previous.map((row, index) => ({ ...row, selected: canSelect(index) && evaluations[index].duplicate === "new" })))}>
          Select All New
        </button>}
        <button type="submit" className="button-primary" disabled={single ? alreadyExists > 0 || imported > 0 : !rows.some((row, index) => row.selected && canSelect(index))}>
          {disabled ? "Saving…" : single ? "Add Assignment" : "Import Selected"}
        </button>
        <button type="button" className="button-secondary" onClick={onTryAgain}>{hasImported ? "Done reviewing" : "Try Again"}</button>
      </div>
    </fieldset>
    {hasImported && <p role="status" className="text-xs text-blue-200">
      {rows.length} {single ? "assignment" : "assignments"} detected. {imported} imported, {alreadyExists} already existed, {needsReview} need review, {notSelected} not selected.
    </p>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
  </form>;
}
