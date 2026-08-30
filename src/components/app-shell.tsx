import type { ReactNode } from "react";
import { Brand } from "./brand";

export interface ShellNavItem {
  href: string;
  label: string;
  current?: boolean;
}

export function AppShell({
  subtitle,
  userLabel,
  roleLabel,
  nav = [],
  children,
}: {
  subtitle: string;
  userLabel: string;
  /** Server-derived label (e.g. Owner/Manager/Staff for the selected business); visible text, never color-only. */
  roleLabel: string;
  /** Optional workspace navigation (e.g. the owner-only Team & access link). */
  nav?: ShellNavItem[];
  children: ReactNode;
}) {
  return (
    <>
      <header className="shell-header">
        <div className="shell-header__inner">
          <Brand subtitle={subtitle} />
          {nav.length > 0 ? (
            <nav className="shell-nav" aria-label="Workspace">
              {nav.map((item) => (
                <a key={item.href} href={item.href} aria-current={item.current ? "page" : undefined}>
                  {item.label}
                </a>
              ))}
            </nav>
          ) : null}
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
