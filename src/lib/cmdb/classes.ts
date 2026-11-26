/** Default CI classes for a new tenant. Tenants can add classes and attributes. */
export type CiAttribute = {
  key: string
  label: string
  type: "text" | "number" | "date" | "select" | "boolean"
  options?: string[]
  required?: boolean
}

export type CiClassDef = {
  key: string
  name: string
  category: "hardware" | "software" | "service" | "network" | "facility" | "other"
  attributes: CiAttribute[]
}

// The legacy asset register's detail keys (serial_no is a column here)
const COMPUTER: CiAttribute[] = [
  { key: "hostname", label: "Host name", type: "text" },
  { key: "cpu", label: "CPU", type: "text" },
  { key: "ram", label: "RAM", type: "text" },
  { key: "storage", label: "Storage", type: "text" },
  { key: "os_name", label: "Operating system", type: "text" },
  { key: "os_version", label: "OS version", type: "text" },
  { key: "mac_address", label: "MAC address", type: "text" },
  { key: "ip_address", label: "IP address", type: "text" },
  { key: "vendor", label: "Vendor", type: "text" },
]

export const DEFAULT_CI_CLASSES: CiClassDef[] = [
  { key: "laptop", name: "Laptop", category: "hardware", attributes: COMPUTER },
  { key: "desktop", name: "Desktop", category: "hardware", attributes: COMPUTER },
  { key: "server", name: "Server", category: "hardware", attributes: [...COMPUTER, { key: "rack", label: "Rack / position", type: "text" }] },
  { key: "virtual_machine", name: "Virtual machine", category: "hardware", attributes: [...COMPUTER, { key: "host", label: "Hypervisor host", type: "text" }] },
  { key: "monitor", name: "Monitor", category: "hardware", attributes: [{ key: "size", label: "Size (inches)", type: "number" }, { key: "vendor", label: "Vendor", type: "text" }] },
  { key: "printer", name: "Printer / scanner", category: "hardware", attributes: [{ key: "ip_address", label: "IP address", type: "text" }, { key: "vendor", label: "Vendor", type: "text" }] },
  { key: "mobile", name: "Mobile device", category: "hardware", attributes: [{ key: "imei", label: "IMEI", type: "text" }, { key: "phone_number", label: "Phone number", type: "text" }, { key: "os_name", label: "Operating system", type: "text" }] },
  { key: "peripheral", name: "Peripheral", category: "hardware", attributes: [{ key: "vendor", label: "Vendor", type: "text" }] },
  {
    key: "network_device",
    name: "Network device",
    category: "network",
    attributes: [
      { key: "device_role", label: "Role", type: "select", options: ["router", "switch", "firewall", "access point", "load balancer", "other"] },
      { key: "ip_address", label: "Management IP", type: "text" },
      { key: "mac_address", label: "MAC address", type: "text" },
      { key: "firmware", label: "Firmware", type: "text" },
      { key: "ports", label: "Ports", type: "number" },
    ],
  },
  {
    key: "software",
    name: "Software licence",
    category: "software",
    attributes: [
      { key: "version", label: "Version", type: "text" },
      { key: "vendor", label: "Vendor", type: "text" },
      { key: "license_type", label: "Licence type", type: "select", options: ["perpetual", "subscription", "open source", "freeware"] },
      { key: "seats", label: "Seats", type: "number" },
      { key: "license_expiry", label: "Licence expiry", type: "date" },
    ],
  },
  { key: "database", name: "Database", category: "software", attributes: [{ key: "engine", label: "Engine", type: "text" }, { key: "version", label: "Version", type: "text" }, { key: "port", label: "Port", type: "number" }] },
  { key: "application", name: "Business application", category: "service", attributes: [{ key: "url", label: "URL", type: "text" }, { key: "vendor", label: "Vendor", type: "text" }] },
  { key: "service", name: "IT service", category: "service", attributes: [{ key: "service_hours", label: "Service hours", type: "text" }, { key: "sla_target", label: "Availability target", type: "text" }] },
  { key: "other", name: "Other", category: "other", attributes: [] },
]

/** Free-text legacy asset types → class keys. */
export function classKeyForLegacyType(assetType: string | null | undefined): string {
  const t = (assetType ?? "").toLowerCase()
  if (/laptop|notebook|macbook/.test(t)) return "laptop"
  if (/desktop|workstation|\bpc\b|cpu|tower|all.?in.?one/.test(t)) return "desktop"
  if (/server/.test(t)) return "server"
  if (/\bvm\b|virtual/.test(t)) return "virtual_machine"
  if (/monitor|display|screen|tv/.test(t)) return "monitor"
  if (/print|scan|copier|mfp/.test(t)) return "printer"
  if (/phone|mobile|tablet|ipad|android|iphone/.test(t)) return "mobile"
  if (/router|switch|firewall|access.?point|\bap\b|wifi|wi-fi|network|modem/.test(t)) return "network_device"
  if (/keyboard|mouse|headset|webcam|camera|dock|ups|projector|speaker|peripheral|hdd|ssd|drive/.test(t)) return "peripheral"
  if (/licen[cs]e|software/.test(t)) return "software"
  return "other"
}
