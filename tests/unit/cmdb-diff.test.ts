import { describe, expect, it } from "vitest"
import { diffAttributes, diffFields, hasChanges, normalizeValue, sameValue } from "@/lib/cmdb/diff"

describe("CI diff helper", () => {
  it("lists only the fields that changed, with from and to", () => {
    const d = diffFields({ name: "Old", status: "in_use", cost: 100 }, { name: "New", status: "in_use", cost: 100 })
    expect(d).toEqual({ name: { from: "Old", to: "New" } })
  })

  it("treats empty string, undefined and null as the same", () => {
    expect(diffFields({ room: "", notes: null }, { room: null, notes: undefined })).toEqual({})
    expect(sameValue("", null)).toBe(true)
    expect(normalizeValue(undefined)).toBeNull()
  })

  it("describes a creation and a deletion", () => {
    expect(diffFields(null, { ci_code: "LAP-1", name: "Laptop", room: null })).toEqual({
      ci_code: { from: null, to: "LAP-1" },
      name: { from: null, to: "Laptop" },
    })
    expect(diffFields({ ci_code: "LAP-1" }, null)).toEqual({ ci_code: { from: "LAP-1", to: null } })
  })

  it("restricts the comparison to the given fields", () => {
    expect(diffFields({ a: 1, b: 1 }, { a: 2, b: 2 }, ["b"])).toEqual({ b: { from: 1, to: 2 } })
  })

  it("compares dates by instant and numbers by value", () => {
    const t = "2026-01-02T03:04:05.000Z"
    expect(diffFields({ at: new Date(t) }, { at: t })).toEqual({})
    expect(diffFields({ at: new Date(t) }, { at: new Date("2026-01-03T00:00:00Z") })).toEqual({ at: { from: t, to: "2026-01-03T00:00:00.000Z" } })
    expect(diffFields({ n: 0 }, { n: null })).toEqual({ n: { from: 0, to: null } })
    expect(diffFields({ b: false }, { b: null })).toEqual({ b: { from: false, to: null } })
  })

  it("compares objects regardless of key order", () => {
    expect(sameValue({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true)
    expect(sameValue({ a: 1 }, { a: 1, b: null })).toBe(true)
    expect(sameValue([1, 2], [2, 1])).toBe(false)
  })

  it("diffs attributes per key with a prefix", () => {
    const d = diffAttributes({ cpu: "i5", ram: "8 GB", os_name: "Windows 10" }, { cpu: "i5", ram: "16 GB", mac_address: "AA:BB" })
    expect(d).toEqual({
      "attributes.ram": { from: "8 GB", to: "16 GB" },
      "attributes.os_name": { from: "Windows 10", to: null },
      "attributes.mac_address": { from: null, to: "AA:BB" },
    })
    expect(hasChanges(diffAttributes(null, {}))).toBe(false)
  })
})
