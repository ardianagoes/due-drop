"use client";

import { CATEGORIES } from "@/lib/tasks";
import type { AssignmentDraft, Candidate } from "@/lib/assignment-draft";

export default function TaskReviewFields({ candidate, draft, update, required }: {
  candidate: Candidate;
  draft: AssignmentDraft;
  update: (patch: Partial<AssignmentDraft>) => void;
  required: boolean;
}) {
  const uncertain = (field: Candidate["uncertainFields"][number]) => candidate.uncertainFields.includes(field);
  const style = (field: Candidate["uncertainFields"][number]) => `control mt-1 ${uncertain(field) ? "border-amber-500/70" : ""}`;
  return <div className="space-y-3 text-sm text-slate-300">
    {candidate.dateExpression && <p className="text-xs text-slate-400">Deadline text: {candidate.dateExpression}</p>}
    {candidate.notes.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-amber-200">{candidate.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
      <label className="block">Task name{uncertain("name") && <span className="ml-1 text-xs text-amber-200">· check</span>}
        <input name="name" className={style("name")} value={draft.name} required={required} maxLength={200} onChange={event => update({ name: event.target.value })} /></label>
      <label className="block">Course <span className="text-xs text-slate-400">optional</span>
        <input name="course" className={style("course")} value={draft.course ?? ""} maxLength={160} onChange={event => update({ course: event.target.value })} /></label>
      <label className="block">Due date{uncertain("dueDate") && <span className="ml-1 text-xs text-amber-200">· check date/year</span>}
        <input name="dueDate" type="date" className={style("dueDate")} value={draft.dueDate} required={required} onInput={event => update({ dueDate: event.currentTarget.value })} onChange={event => update({ dueDate: event.target.value })} /></label>
      <label className="flex min-h-9 items-center gap-2"><input name="allDay" type="checkbox" checked={draft.allDay}
        className="h-4 w-4 accent-blue-500" onChange={event => update({ allDay: event.target.checked })} />All day · time unspecified</label>
      {!candidate.dueTime && <p className="text-xs text-amber-200">No clear due time was detected. Keep all day or enter a time.</p>}
      {!draft.allDay && <>
        <label className="block">Due time{uncertain("dueTime") && <span className="ml-1 text-xs text-amber-200">· check</span>}
          <input name="dueTime" type="time" className={style("dueTime")} value={draft.dueTime} required={required} onInput={event => update({ dueTime: event.currentTarget.value })} onChange={event => update({ dueTime: event.target.value })} /></label>
        <label className="block">Timezone{uncertain("timezone") && <span className="ml-1 text-xs text-amber-200">· confirm</span>}
          <input name="timezone" className={style("timezone")} value={draft.timezone} required={required} maxLength={100} placeholder="America/New_York"
            onChange={event => update({ timezone: event.target.value })} /></label>
      </>}
      <label className="block">Category<select name="category" className="control mt-1" value={draft.category}
        onChange={event => update({ category: event.target.value as AssignmentDraft["category"] })}>{CATEGORIES.map(category => <option key={category}>{category}</option>)}</select></label>
      <label className="block">Useful URLs <span className="text-xs text-slate-400">(optional)</span><textarea name="urls" className={style("usefulUrl")} rows={2}
        value={draft.urls} onChange={event => update({ urls: event.target.value })} /></label>
  </div>;
}
