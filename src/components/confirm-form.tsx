"use client";

import type { ReactNode } from "react";

// Plain form POST with a browser confirmation for destructive-looking team
// actions (deactivation, invitation revocation). UX only - the security
// boundary is the server route and the database RPCs, never this dialog.
export function ConfirmForm({
  action,
  confirm,
  fields,
  children,
  className = "inline-form",
}: {
  action: string;
  confirm: string;
  fields: Record<string, string>;
  children: ReactNode;
  className?: string;
}) {
  return (
    <form
      method="post"
      action={action}
      className={className}
      onSubmit={(e) => {
        if (!window.confirm(confirm)) e.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
    </form>
  );
}
