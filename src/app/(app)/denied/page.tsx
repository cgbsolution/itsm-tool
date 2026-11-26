import Link from "next/link"
import { EmptyState } from "@/components/ui"

export const metadata = { title: "No access" }

export default function DeniedPage() {
  return (
    <EmptyState title="You do not have access to that page" action={<Link href="/" className="btn">Back to the dashboard</Link>}>
      If you need it for your work, ask an administrator to change your role.
    </EmptyState>
  )
}
