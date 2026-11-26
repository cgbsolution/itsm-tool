import { describe, expect, it } from "vitest"
import { mapColumns, mapStatus, normalizeHeader, normalizeRow, resolveClass, type ImportClass } from "@/lib/cmdb/mapping"
import { addYears, parseDateInput, warrantyState } from "@/lib/cmdb/values"
import { applyAttributes, parseAttributeSchema } from "@/lib/cmdb/attributes"
import { classKeyForDevice, deviceAttributes, usableSerial } from "@/lib/cmdb/service"

describe("import column mapping", () => {
  it("maps fields and aliases, and sends other columns to attributes", () => {
    const cols = mapColumns(["Asset Code", "Name", "Asset Type", "Serial", "Vendor", "Assigned To Email", "CPU", "RAM", "OS Name", "MAC Address", "", "2nd"])
    const t = cols.map((c) => (c.target.kind === "field" ? c.target.field : c.target.kind === "attribute" ? `attr:${c.target.key}` : "ignored"))
    expect(t).toEqual(["ci_code", "name", "class", "serial_no", "manufacturer", "owner_email", "attr:cpu", "attr:ram", "attr:os_name", "attr:mac_address", "ignored", "ignored"])
  })

  it("lets the first column of a field win; a later alias becomes an attribute", () => {
    const cols = mapColumns(["ci_code", "manufacturer", "vendor", "code"])
    expect(cols[2].target).toEqual({ kind: "attribute", key: "vendor" })
    expect(cols[3].target).toEqual({ kind: "attribute", key: "code" })
    expect(normalizeHeader("  Warranty Expiry (date) ")).toBe("warranty_expiry_date")
  })

  it("maps statuses including spare → in stock", () => {
    expect(mapStatus("Spare")).toBe("in_stock")
    expect(mapStatus("in use")).toBe("in_use")
    expect(mapStatus("RETIRED")).toBe("retired")
    expect(() => mapStatus("borrowed")).toThrow(/unknown status/)
  })

  it("normalises a row: dates in both formats, warranty from purchase + years, errors per field", () => {
    const cols = mapColumns(["ci_code", "name", "status", "purchase_date", "warranty_years", "cost", "condition", "ram"])
    const ok = normalizeRow(["LAP-1", "Laptop", "spare", "15/03/2024", "3", "1,250.50", "Good", "16 GB"], cols, 2)
    expect(ok.errors).toEqual([])
    expect(ok.values).toMatchObject({ ci_code: "LAP-1", status: "in_stock", purchase_date: "2024-03-15", warranty_years: 3, warranty_expiry: "2027-03-15", cost: 1250.5, condition: "good" })
    expect(ok.rawAttributes).toEqual({ ram: "16 GB" })

    const bad = normalizeRow(["", "X", "borrowed", "31/02/2024", "ten", "", "", ""], cols, 3)
    expect(bad.values).toBeNull()
    expect(bad.errors.join(" | ")).toMatch(/CI code is empty.*Status.*Purchase date.*Warranty years/)
  })

  it("resolves classes by key, name or legacy free text", () => {
    const classes: ImportClass[] = [
      { id: "1", key: "laptop", name: "Laptop", is_active: true, attributes: [] },
      { id: "2", key: "network_device", name: "Network device", is_active: true, attributes: [] },
      { id: "3", key: "other", name: "Other", is_active: true, attributes: [] },
    ]
    expect(resolveClass("network_device", classes).cls?.id).toBe("2")
    expect(resolveClass("Network Device", classes).cls?.id).toBe("2")
    expect(resolveClass("Dell Notebook", classes).cls?.id).toBe("1")
    expect(resolveClass("Core switch", classes).cls?.id).toBe("2")
    const other = resolveClass("Coffee machine", classes)
    expect(other.cls?.id).toBe("3")
    expect(other.warning).toMatch(/not recognised/)
  })
})

describe("values and attributes", () => {
  it("parses dates strictly", () => {
    expect(parseDateInput("2024-02-29")).toBe("2024-02-29")
    expect(parseDateInput("1/2/2024")).toBe("2024-02-01")
    expect(parseDateInput("")).toBeNull()
    expect(() => parseDateInput("2023-02-29")).toThrow()
    expect(() => parseDateInput("02/31/2024")).toThrow()
    expect(addYears("2024-02-29", 1)).toBe("2025-02-28")
  })

  it("classifies warranties", () => {
    expect(warrantyState("2026-01-01", "2026-01-02").state).toBe("expired")
    expect(warrantyState("2026-01-20", "2026-01-02")).toEqual({ state: "expiring", days: 18 })
    expect(warrantyState("2027-01-01", "2026-01-02").state).toBe("ok")
    expect(warrantyState(null, "2026-01-02").state).toBe("none")
  })

  it("validates attribute schemas and values", () => {
    expect(() => parseAttributeSchema([{ key: "9lives", type: "text" }])).toThrow(/lower-case/)
    expect(() => parseAttributeSchema([{ key: "a" }, { key: "a" }])).toThrow(/twice/)
    expect(() => parseAttributeSchema([{ key: "role", type: "select", options: "" }])).toThrow(/option/)
    expect(() => parseAttributeSchema([{ key: "status" }])).toThrow(/built-in/)
    const schema = parseAttributeSchema([
      { key: "ports", label: "Ports", type: "number", required: "on" },
      { key: "role", type: "select", options: "router, switch" },
      { key: "", label: "" },
    ])
    expect(schema).toEqual([
      { key: "ports", label: "Ports", type: "number", required: true },
      { key: "role", label: "Role", type: "select", options: ["router", "switch"] },
    ])
    expect(applyAttributes(schema, { extra: "kept" }, { ports: "24", role: "SWITCH" }, "form")).toEqual({ attributes: { extra: "kept", ports: 24, role: "switch" }, errors: [] })
    expect(applyAttributes(schema, {}, { role: "hub" }, "form").errors).toEqual(['Role: "hub" is not one of: router, switch', "Ports is required"])
    expect(applyAttributes(schema, { ports: 8 }, { firmware: " 1.2 " }, "merge").attributes).toEqual({ ports: 8, firmware: "1.2" })
  })
})

describe("agent device mapping", () => {
  it("picks server / laptop / desktop", () => {
    expect(classKeyForDevice({ os_name: "Microsoft Windows Server 2022 Standard", model: "PowerEdge R650" })).toBe("server")
    expect(classKeyForDevice({ os_name: "Windows 11 Pro", model: "Latitude 5440" })).toBe("laptop")
    expect(classKeyForDevice({ os_name: "Windows 11 Pro", model: "OptiPlex 7010" })).toBe("desktop")
    expect(classKeyForDevice({ os_name: "Ubuntu 24.04", model: "To Be Filled By O.E.M." })).toBe("desktop")
  })

  it("ignores placeholder serial numbers", () => {
    expect(usableSerial("To be filled by O.E.M.")).toBeNull()
    expect(usableSerial("0000000")).toBeNull()
    expect(usableSerial("Default string")).toBeNull()
    expect(usableSerial(" 5CG1234XYZ ")).toBe("5CG1234XYZ")
  })

  it("derives attributes from inventory", () => {
    expect(deviceAttributes({ hostname: "pc-01", cpu: "Intel i7", ram_mb: 16_000, os_name: "Windows 11", mac_addresses: ["aa:bb:cc:dd:ee:ff", "00:00:00:00:00:00"], ip_addresses: ["10.0.0.5", "127.0.0.1"] })).toEqual({
      hostname: "pc-01", cpu: "Intel i7", ram: "16 GB", os_name: "Windows 11", mac_address: "AA:BB:CC:DD:EE:FF", ip_address: "10.0.0.5",
    })
  })
})
