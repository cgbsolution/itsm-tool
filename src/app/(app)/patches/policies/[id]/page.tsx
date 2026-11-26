import { notFound } from "next/navigation"
import { requirePermission, can } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { getPolicy, listDeviceGroups, patchMaintenanceWindows } from "@/lib/endpoints/queries"
import { formatDateTime } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, PageHeader } from "@/components/ui"
import { PolicyFields } from "../form"
import { deletePolicyAction, updatePolicyAction } from "../../actions"

export const metadata = { title: "Patch policy" }

export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("patch.deploy")
  const { id } = await params
  let policy
  try {
    policy = await getPolicy(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const tz = actor.tenant.timezone
  const [groups, windows] = await Promise.all([listDeviceGroups(actor.tenantId), patchMaintenanceWindows(actor.tenantId)])

  return (
    <>
      <PageHeader
        back={{ href: "/patches/policies", label: "Policies" }}
        title={policy.name}
        subtitle={`Created ${formatDateTime(policy.created_at, tz)}${policy.last_run_at ? ` · last run ${formatDateTime(policy.last_run_at, tz)}` : ""}`}
        actions={
          <ActionForm action={deletePolicyAction.bind(null, policy.id)} confirm={`Delete the policy ${policy.name}? Deployments it created are kept.`}>
            <SubmitButton className="btn btn-danger">Delete</SubmitButton>
          </ActionForm>
        }
      />
      <Card>
        <ActionForm action={updatePolicyAction.bind(null, policy.id)} className="space-y-4">
          <PolicyFields policy={policy} groups={groups} windows={windows} canApprove={can(actor, "patch.approve")} tz={tz} />
          <SubmitButton>Save policy</SubmitButton>
        </ActionForm>
      </Card>
    </>
  )
}
