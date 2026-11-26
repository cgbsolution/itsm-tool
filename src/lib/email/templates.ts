/**
 * Email templates. Defaults live here and carry no product or customer
 * branding: {{brand.name}} comes from the tenant's settings. Tenants override
 * subject/body per key in Admin > Email templates (email_templates table).
 * Bodies are plain text with {{placeholders}}; the HTML layout is applied on send.
 */

export type TemplateDef = { subject: string; body: string; description: string }

export const DEFAULT_TEMPLATES: Record<string, TemplateDef> = {
  "ticket.created": {
    description: "To the requester when a ticket is raised",
    subject: "[{{ticket.number}}] We have received your request: {{ticket.subject}}",
    body: `Hello {{recipient.name}},

Thank you for contacting {{brand.name}}. Your {{ticket.type}} has been logged.

Number: {{ticket.number}}
Subject: {{ticket.subject}}
Priority: {{ticket.priority}}

We will keep you updated. Reply to this email to add more information.

{{ticket.url}}`,
  },
  "ticket.assigned": {
    description: "To an engineer when a ticket is assigned to them",
    subject: "[{{ticket.number}}] Assigned to you: {{ticket.subject}}",
    body: `Hello {{recipient.name}},

{{actor.name}} assigned {{ticket.type}} {{ticket.number}} to you.

Subject: {{ticket.subject}}
Priority: {{ticket.priority}}
Requester: {{ticket.requester}}
{{note}}

{{ticket.url}}`,
  },
  "ticket.updated": {
    description: "To the requester when the status of their ticket changes",
    subject: "[{{ticket.number}}] {{ticket.status}}: {{ticket.subject}}",
    body: `Hello {{recipient.name}},

{{message}}

Number: {{ticket.number}}
Subject: {{ticket.subject}}
Status: {{ticket.status}}
{{note}}

{{ticket.url}}`,
  },
  "ticket.resolved": {
    description: "To the requester when their ticket is resolved",
    subject: "[{{ticket.number}}] Resolved: {{ticket.subject}}",
    body: `Hello {{recipient.name}},

Your {{ticket.type}} {{ticket.number}} has been resolved by {{actor.name}}.

Resolution: {{ticket.resolution}}

If the problem is not fixed, reply to this email or reopen the ticket within {{reopen_days}} days. Otherwise it will close automatically.

{{ticket.url}}`,
  },
  "ticket.comment": {
    description: "New public reply on a ticket",
    subject: "[{{ticket.number}}] New reply: {{ticket.subject}}",
    body: `Hello {{recipient.name}},

{{actor.name}} wrote:

{{comment}}

Reply to this email to answer.

{{ticket.url}}`,
  },
  "sla.warning": {
    description: "To the assignee when an SLA target is close",
    subject: "[{{ticket.number}}] SLA warning: {{sla.kind}} due {{sla.due}}",
    body: `Hello {{recipient.name}},

The {{sla.kind}} target for {{ticket.number}} ({{ticket.priority}}) is due at {{sla.due}}.

Subject: {{ticket.subject}}

{{ticket.url}}`,
  },
  "sla.breach": {
    description: "Escalation when an SLA target is missed",
    subject: "[{{ticket.number}}] SLA breached: {{sla.kind}}",
    body: `Hello {{recipient.name}},

The {{sla.kind}} target for {{ticket.number}} ({{ticket.priority}}) was missed at {{sla.due}}.

Subject: {{ticket.subject}}
Assigned to: {{ticket.assignee}}

{{ticket.url}}`,
  },
  "approval.requested": {
    description: "To approvers when their approval is needed",
    subject: "[{{ticket.number}}] Approval needed: {{ticket.subject}}",
    body: `Hello {{recipient.name}},

Your approval is needed for {{ticket.type}} {{ticket.number}}, requested by {{actor.name}}.

Subject: {{ticket.subject}}
{{details}}

Approve or reject here: {{approvals.url}}`,
  },
  "approval.decided": {
    description: "To the requester / change owner when approval is decided",
    subject: "[{{ticket.number}}] {{decision}}: {{ticket.subject}}",
    body: `Hello {{recipient.name}},

{{ticket.type}} {{ticket.number}} was {{decision}}.
{{note}}

{{ticket.url}}`,
  },
  "user.invite": {
    description: "Invitation to set a password",
    subject: "You have been invited to {{brand.name}}",
    body: `Hello {{recipient.name}},

An account has been created for you at {{brand.name}}. Set your password using this link (valid for {{hours}} hours):

{{link}}`,
  },
  "user.password_reset": {
    description: "Password reset link",
    subject: "Reset your {{brand.name}} password",
    body: `Hello {{recipient.name}},

Someone asked to reset the password for this account. If it was you, use this link (valid for {{hours}} hours):

{{link}}

If it was not you, ignore this email.`,
  },
}

type Vars = Record<string, unknown>

function lookup(vars: Vars, path: string): unknown {
  let cur: unknown = vars
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Plain-text rendering. Lines that become empty after substitution are dropped. */
export function renderText(template: string, vars: Vars): string {
  const lines = template.split("\n").map((line) => {
    const hadVar = /\{\{\s*[\w.]+\s*\}\}/.test(line)
    const out = line.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p: string) => {
      const v = lookup(vars, p)
      return v === undefined || v === null ? "" : String(v)
    })
    return hadVar && out.trim() === "" ? null : out
  })
  return lines.filter((l): l is string => l !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** HTML body from rendered text: escaped, line breaks kept, URLs linked. */
export function textToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" style="color:inherit">${url}</a>`)
    .replace(/\n/g, "<br>\n")
}

export function layoutHtml(bodyHtml: string, brand: { name: string; color: string }): string {
  const name = escapeHtml(brand.name)
  const color = /^#[0-9a-fA-F]{6}$/.test(brand.color) ? brand.color : "#2563eb"
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
<tr><td style="background:${color};color:#ffffff;padding:16px 24px;font-size:16px;font-weight:600">${name}</td></tr>
<tr><td style="padding:24px;font-size:14px;line-height:1.6">${bodyHtml}</td></tr>
<tr><td style="padding:12px 24px;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb">This message was sent by ${name}. Keep the reference in the subject when you reply.</td></tr>
</table></body></html>`
}
