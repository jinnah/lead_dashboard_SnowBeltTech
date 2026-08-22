import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { getViewer } from "@/lib/server/viewer";

export const dynamic = "force-dynamic";

// Signed in, but no active authorized business (inactive profile, inactive
// membership, suspended/archived business). Shows nothing tenant-specific.
export default async function NoAccessPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.access.kind === "admin") redirect("/admin");
  if (viewer.access.kind === "customer") redirect("/dashboard");
  return (
    <div className="login-wrap">
      <main className="login-card">
        <Brand subtitle="Lead Portal" />
        <h1>Access unavailable</h1>
        <p>Your account is signed in, but it does not currently have access to a business workspace.</p>
        <p className="muted">If you believe this is a mistake, contact SnowBeltTech support.</p>
        <form method="post" action="/api/auth/logout">
          <button type="submit" className="btn btn--primary">Sign out</button>
        </form>
      </main>
    </div>
  );
}
