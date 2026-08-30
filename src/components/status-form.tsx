"use client";

import { useState } from "react";

const CONFIRM: Record<string, string> = {
  spam: "Mark this lead as spam? It will be treated as closed.",
  lost: "Mark this lead as lost?",
};

// Plain form POST; the only client behaviour is a confirmation for terminal-looking statuses.
export function StatusForm({ action, current, options }: { action: string; current: string; options: ReadonlyArray<{ value: string; label: string }> }) {
  const [value, setValue] = useState(current);
  return (
    <form
      method="post"
      action={action}
      className="inline-form"
      onSubmit={(e) => {
        const msg = CONFIRM[value];
        if (msg && value !== current && !window.confirm(msg)) e.preventDefault();
      }}
    >
      <input type="hidden" name="action" value="set_status" />
      <label className="field">
        <span className="field__label">Set status</span>
        <select className="field__input" name="status" value={value} onChange={(e) => setValue(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn btn--primary">Update status</button>
    </form>
  );
}
