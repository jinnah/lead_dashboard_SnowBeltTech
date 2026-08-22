import { redirect } from "next/navigation";
import { getViewer } from "@/lib/server/viewer";

export const dynamic = "force-dynamic";

// Root: route the visitor by server-validated identity and effective access.
export default async function RootPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.access.kind === "admin") redirect("/admin");
  if (viewer.access.kind === "customer") redirect("/dashboard");
  redirect("/no-access");
}
