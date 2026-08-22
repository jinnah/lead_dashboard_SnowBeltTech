import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { getViewer } from "@/lib/server/viewer";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const viewer = await getViewer();
  if (viewer) redirect("/");
  const { error } = await searchParams;
  return (
    <div className="login-wrap">
      <main className="login-card">
        <Brand subtitle="Lead Portal" />
        <h1>Sign in</h1>
        <p className="muted">Access your business&apos;s lead workspace.</p>
        {error ? (
          <div className="alert alert--error" role="alert">
            We couldn&apos;t sign you in. Check your email and password and try again.
          </div>
        ) : null}
        <form method="post" action="/api/auth/login" noValidate>
          <label className="field">
            <span className="field__label">Email</span>
            <input className="field__input" type="email" name="email" autoComplete="username" required maxLength={320} />
          </label>
          <label className="field">
            <span className="field__label">Password</span>
            <input className="field__input" type="password" name="password" autoComplete="current-password" required maxLength={1024} />
          </label>
          <button type="submit" className="btn btn--primary" style={{ width: "100%" }}>
            Sign in
          </button>
        </form>
        <p className="muted" style={{ marginTop: "1.25rem", fontSize: "0.85rem" }}>
          Accounts are created by SnowBeltTech. Contact your account manager if you need access.
        </p>
      </main>
    </div>
  );
}
