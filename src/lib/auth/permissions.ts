/**
 * Permission model. System roles are fixed here; tenants can add custom roles
 * (custom_roles) with any subset of these permissions.
 *
 * Everyone who can sign in may, without a permission: see and comment on their
 * own tickets, use the service catalog, read published public knowledge
 * articles, act on approvals assigned to them, and manage their own profile.
 */
export const PERMISSIONS = {
  "ticket.create": "Raise incidents and requests",
  "ticket.view_all": "See every ticket in the tenant",
  "ticket.work": "Work tickets: pick up, update, internal notes, change status",
  "ticket.assign": "Assign and transfer any ticket, act on tickets assigned to others",
  "ticket.delete": "Delete tickets",
  "problem.manage": "Create and manage problems",
  "change.manage": "Create and manage changes",
  "catalog.manage": "Manage the service catalog",
  "kb.write": "Write knowledge articles",
  "kb.publish": "Publish and retire knowledge articles",
  "cmdb.view": "View the CMDB",
  "cmdb.edit": "Create, edit and import configuration items",
  "cmdb.delete": "Delete configuration items",
  "endpoint.view": "View endpoints, inventory and patch status",
  "endpoint.manage": "Enrol devices, run inventory and scans, manage device groups",
  "endpoint.run_script": "Run scripts on endpoints",
  "patch.approve": "Approve or decline patches",
  "patch.deploy": "Create and run patch deployments and policies",
  "report.view": "View reports and export data",
  "audit.view": "View and verify the audit log",
  "admin.users": "Manage users, groups and roles",
  "admin.itsm": "Configure categories, priorities, SLAs, custom fields, email templates",
  "admin.settings": "Tenant settings, email, sign-in providers, API tokens",
  "admin.license": "Install the licence (super admin)",
  "admin.tenants": "Manage all tenants (super admin)",
} as const

export type Permission = keyof typeof PERMISSIONS
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[]

export const SYSTEM_ROLES = {
  user: {
    name: "Requester",
    description: "Raises tickets and requests, reads the knowledge base",
    permissions: ["ticket.create"] as Permission[],
  },
  engineer: {
    name: "Engineer",
    description: "IT team member who works tickets",
    permissions: [
      "ticket.create",
      "ticket.view_all",
      "ticket.work",
      "problem.manage",
      "change.manage",
      "kb.write",
      "cmdb.view",
      "cmdb.edit",
      "endpoint.view",
      "report.view",
    ] as Permission[],
  },
  admin: {
    name: "Administrator",
    description: "Full control of this tenant",
    // the licence and the tenant list belong to the whole installation: super admins only
    permissions: ALL_PERMISSIONS.filter((p) => p !== "admin.tenants" && p !== "admin.license"),
  },
  superadmin: {
    name: "Super administrator",
    description: "Full control of every tenant",
    permissions: ALL_PERMISSIONS,
  },
} as const

export type SystemRole = keyof typeof SYSTEM_ROLES

export function isSystemRole(role: string): role is SystemRole {
  return Object.prototype.hasOwnProperty.call(SYSTEM_ROLES, role)
}

export function isPermission(v: string): v is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, v)
}

/** Permissions of a role: a system role, or a custom role's stored list. */
export function permissionsFor(role: string, customRolePermissions?: string[] | null): Set<Permission> {
  if (isSystemRole(role)) return new Set(SYSTEM_ROLES[role].permissions)
  return new Set((customRolePermissions ?? []).filter(isPermission).filter((p) => p !== "admin.tenants" && p !== "admin.license"))
}

/** Roles that count as the IT team (see all tickets). */
export function isStaff(perms: Set<Permission>): boolean {
  return perms.has("ticket.view_all")
}
