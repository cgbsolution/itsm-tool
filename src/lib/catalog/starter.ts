/** The "Create starter items" set: four typical requests with sensible forms. Nothing is seeded automatically. */
import type { FormField, TaskTemplate } from "@/lib/catalog/forms"
import type { Priority } from "@/lib/itsm/vocab"

export type StarterItem = {
  category: string
  name: string
  shortDescription: string
  description: string
  priority: Priority
  requiresApproval: boolean
  approveByManager: boolean
  fields: FormField[]
  tasks: TaskTemplate[]
}

const f = (key: string, label: string, type: FormField["type"], opts: Partial<Omit<FormField, "key" | "label" | "type">> = {}): FormField => ({
  key,
  label,
  type,
  required: opts.required ?? false,
  options: opts.options ?? [],
  help: opts.help ?? null,
})

export const STARTER_CATEGORIES: Record<string, string> = {
  Hardware: "Computers, phones and accessories",
  Software: "Applications and licences",
  Access: "Accounts, remote access and shared resources",
}

export const STARTER_ITEMS: StarterItem[] = [
  {
    category: "Hardware",
    name: "New laptop",
    shortDescription: "A standard company laptop for a new joiner or to replace a broken or old one.",
    description:
      "Request a company laptop.\n\n- **Standard** suits office work, email and browsing.\n- **Performance** is for development, data and design work.\n\nYour manager approves the request. Delivery usually takes 3 to 5 working days once approved.",
    priority: "medium",
    requiresApproval: true,
    approveByManager: true,
    fields: [
      f("for_person", "Who is it for?", "text", { required: true, help: "Name of the person who will use the laptop" }),
      f("reason", "Reason", "select", { required: true, options: ["New joiner", "Replacement (broken)", "Replacement (old)", "Additional device"] }),
      f("model", "Model", "select", { required: true, options: ["Standard 14-inch", "Performance 16-inch"] }),
      f("needed_by", "Needed by", "date", { required: true }),
      f("accessories", "Accessories", "multiselect", { options: ["Mouse", "Keyboard", "Docking station", "Headset", "External monitor", "Laptop bag"] }),
      f("old_asset_tag", "Asset tag of the old laptop", "text", { help: "For replacements, e.g. LAP-0042" }),
      f("notes", "Anything else we should know?", "textarea"),
    ],
    tasks: [{ title: "Allocate or order the device" }, { title: "Install the standard image and enrol the device" }, { title: "Hand over to the user" }, { title: "Update the asset record in the CMDB" }],
  },
  {
    category: "Software",
    name: "Software installation",
    shortDescription: "Install an application on your computer, including licensed software.",
    description:
      "Ask for software that is not installed by default. Check the knowledge base first: many common tools can be installed from the company software centre without a request.\n\nLicensed software needs your manager's approval.",
    priority: "low",
    requiresApproval: true,
    approveByManager: true,
    fields: [
      f("software", "Software name", "text", { required: true, help: "Name and edition, e.g. Microsoft Visio Professional" }),
      f("version", "Version", "text", { help: "Leave empty for the latest supported version" }),
      f("device", "Computer name", "text", { required: true, help: "Shown on the sticker or under Settings → About, e.g. LAP-0042" }),
      f("licence", "Licence", "select", { required: true, options: ["Free / open source", "Company licence available", "A new licence is needed", "Not sure"] }),
      f("justification", "Why do you need it?", "textarea", { required: true }),
    ],
    tasks: [{ title: "Check licence availability" }, { title: "Install the software" }, { title: "Confirm with the user that it works" }],
  },
  {
    category: "Access",
    name: "VPN access",
    shortDescription: "Remote access to the company network from home or while travelling.",
    description:
      "Request VPN access to work remotely. You need a company laptop or an approved personal device with up-to-date security software.\n\nAccess is approved by your manager. You receive setup instructions by email.",
    priority: "medium",
    requiresApproval: true,
    approveByManager: true,
    fields: [
      f("access_type", "Access needed", "select", { required: true, options: ["Standard (office applications)", "Extended (server networks)"] }),
      f("device", "Device", "select", { required: true, options: ["Company laptop", "Approved personal device"] }),
      f("start_date", "Start date", "date", { required: true }),
      f("end_date", "End date", "date", { help: "Leave empty for ongoing access" }),
      f("justification", "Business reason", "textarea", { required: true }),
      f("policy", "I have read and accept the remote access policy", "checkbox", { required: true }),
    ],
    tasks: [{ title: "Add the user to the VPN access group" }, { title: "Send setup instructions to the user" }],
  },
  {
    category: "Access",
    name: "Shared mailbox access",
    shortDescription: "Access to a team or department shared mailbox.",
    description: "Ask for access to an existing shared mailbox. The mailbox owner or your manager approves the request.\n\nTo create a **new** shared mailbox, raise a general request instead.",
    priority: "low",
    requiresApproval: true,
    approveByManager: true,
    fields: [
      f("mailbox", "Shared mailbox address", "email", { required: true, help: "e.g. finance@example.com" }),
      f("access_level", "Access level", "select", { required: true, options: ["Read only", "Read and reply (send as)", "Full access"] }),
      f("for_person", "For someone else?", "text", { help: "Leave empty if the access is for you" }),
      f("reason", "Reason", "textarea"),
    ],
    tasks: [{ title: "Grant the mailbox permissions" }, { title: "Confirm access with the user" }],
  },
]
