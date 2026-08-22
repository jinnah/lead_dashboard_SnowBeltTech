import type { ReactNode } from "react";
import { Brand } from "./brand";

export function AppShell({
  subtitle,
  userLabel,
  roleLabel,
  children,
}: {
  subtitle: string;
  userLabel: string;
  roleLabel: string;
  children: ReactNode;
}) {
  return (
    <>
      <header className="shell-header">
        <div className="shell-header__inner">
          <Brand subtitle={subtitle} />
          <div className="shell-user">
            <span>
              <strong>{userLabel}</strong> <span className="muted">· {roleLabel}</span>
            </span>
            <form method="post" action="/api/auth/logout">
              <button type="submit" className="btn btn--ghost">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="shell-main">{children}</main>
    </>
  );
}
