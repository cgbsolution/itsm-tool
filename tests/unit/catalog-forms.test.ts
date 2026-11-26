import { describe, expect, it } from "vitest"
import {
  buildFormFields,
  describeAnswers,
  formatErrors,
  isValidDate,
  normalizeFields,
  parseTaskTemplates,
  requestSubject,
  requireValidValues,
  validateFormValues,
  type FormField,
} from "@/lib/catalog/forms"

const fields: FormField[] = [
  { key: "model", label: "Model", type: "select", required: true, options: ["Standard 14\"", "Performance 16\""], help: null },
  { key: "device_name", label: "Device name", type: "text", required: false, options: [], help: null },
  { key: "qty", label: "Quantity", type: "number", required: true, options: [], help: null },
  { key: "needed_by", label: "Needed by", type: "date", required: true, options: [], help: null },
  { key: "extras", label: "Accessories", type: "multiselect", required: false, options: ["Mouse", "Dock", "Headset"], help: null },
  { key: "contact", label: "Contact email", type: "email", required: false, options: [], help: null },
  { key: "why", label: "Justification", type: "textarea", required: false, options: [], help: null },
  { key: "policy", label: "I accept the policy", type: "checkbox", required: true, options: [], help: null },
  { key: "urgent", label: "Urgent", type: "checkbox", required: false, options: [], help: null },
]

describe("validateFormValues", () => {
  it("accepts and coerces valid values", () => {
    const r = validateFormValues(fields, {
      model: "Standard 14\"",
      device_name: "  LAP   0042 ",
      qty: "2",
      needed_by: "2026-12-01",
      extras: ["Dock", "Mouse", "Dock"],
      contact: "asha@example.com",
      why: "Line one\nLine two",
      policy: "on",
      ignored: "x",
    })
    expect(r).toEqual({
      ok: true,
      values: {
        model: "Standard 14\"",
        device_name: "LAP 0042",
        qty: 2,
        needed_by: "2026-12-01",
        extras: ["Mouse", "Dock"],
        contact: "asha@example.com",
        why: "Line one\nLine two",
        policy: true,
        urgent: false,
      },
    })
  })

  it("accepts JSON-typed values (API)", () => {
    const r = validateFormValues(fields, { model: "Performance 16\"", qty: 3.5, needed_by: "2027-01-31", policy: true, urgent: "true", extras: "Headset" })
    expect(r.ok && r.values).toMatchObject({ qty: 3.5, policy: true, urgent: true, extras: ["Headset"] })
  })

  it("reports every problem with the field label", () => {
    const r = validateFormValues(fields, { model: "Gaming rig", qty: "two", needed_by: "2026-02-30", extras: ["Mouse", "Pony"], contact: "not-an-email", policy: "" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual({
      model: 'Model: "Gaming rig" is not one of the options',
      qty: "Quantity must be a number",
      needed_by: "Needed by must be a valid date (YYYY-MM-DD)",
      extras: 'Accessories: "Pony" is not one of the options',
      contact: "Contact email must be a valid email address",
      policy: "I accept the policy must be ticked",
    })
    expect(formatErrors(fields, r.errors)).toMatch(/^Please check 6 fields: Model: .*; Quantity must be a number; /)
  })

  it("requires required fields and skips empty optional ones", () => {
    const r = validateFormValues(fields, { model: "", qty: "  ", needed_by: undefined, policy: "on" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual({ model: "Model: choose an option", qty: "Quantity is required", needed_by: "Needed by is required" })
    const ok = validateFormValues(fields, { model: "Standard 14\"", qty: "1", needed_by: "2026-12-01", policy: "on", device_name: "", extras: [] })
    expect(ok.ok && Object.keys(ok.values)).toEqual(["model", "qty", "needed_by", "policy", "urgent"])
  })

  it("rejects odd numbers, long text and bad emails", () => {
    const f: FormField[] = [
      { key: "n", label: "N", type: "number", required: false, options: [], help: null },
      { key: "t", label: "T", type: "text", required: false, options: [], help: null },
      { key: "e", label: "E", type: "email", required: false, options: [], help: null },
    ]
    for (const n of ["0x10", "1e400", "Infinity", "1,5", "--1"]) expect(validateFormValues(f, { n }).ok, n).toBe(false)
    for (const n of ["-1", "+2.5", ".5", "10."]) expect(validateFormValues(f, { n }).ok, n).toBe(true)
    expect(validateFormValues(f, { t: "x".repeat(501) }).ok).toBe(false)
    for (const e of ["a@b", "a b@c.de", "@c.de", "a@@c.de", "a@c..de"]) expect(validateFormValues(f, { e }).ok, e).toBe(false)
    expect(validateFormValues(f, { e: "first.last+it@sub.example.co.uk" }).ok).toBe(true)
  })

  it("throws one readable AppError", () => {
    expect(() => requireValidValues(fields.slice(0, 1), {})).toThrow("Model: choose an option")
  })

  it("validates calendar dates", () => {
    expect(isValidDate("2024-02-29")).toBe(true)
    expect(isValidDate("2023-02-29")).toBe(false)
    expect(isValidDate("2026-13-01")).toBe(false)
    expect(isValidDate("26-01-01")).toBe(false)
  })
})

describe("form builder", () => {
  it("orders by sort, drops removed and empty rows, parses options", () => {
    const out = buildFormFields([
      { sort: "20", key: "b", label: "B", type: "select", options: "One\n Two \n\nOne", required: true },
      { sort: "10", key: "a", label: "A", type: "text", options: "ignored" },
      { sort: "5", key: "gone", label: "Gone", type: "text", remove: true },
      { sort: "", key: "", label: "", type: "text" },
      { key: "c", label: "C", type: "checkbox", help: " Tick it " },
    ])
    expect(out).toEqual([
      { key: "a", label: "A", type: "text", required: false, options: [], help: null },
      { key: "b", label: "B", type: "select", required: true, options: ["One", "Two"], help: null },
      { key: "c", label: "C", type: "checkbox", required: false, options: [], help: "Tick it" },
    ])
  })

  it("validates keys, uniqueness, labels, types and options", () => {
    expect(() => buildFormFields([{ key: "Bad Key", label: "X", type: "text" }])).toThrow(/must start with a lower-case letter/)
    expect(() => buildFormFields([{ key: "1abc", label: "X", type: "text" }])).toThrow(/Row 1/)
    expect(() => buildFormFields([{ key: "a".repeat(42), label: "X", type: "text" }])).toThrow(/max 41/)
    expect(() => buildFormFields([{ key: "x", label: "X", type: "text" }, { key: "x", label: "Y", type: "text" }])).toThrow(/Row 2 \(Y\): the key "x" is used twice/)
    expect(() => buildFormFields([{ key: "x", label: "", type: "text" }])).toThrow(/label/)
    expect(() => buildFormFields([{ key: "x", label: "X", type: "html" }])).toThrow(/field type/)
    expect(() => buildFormFields([{ key: "x", label: "X", type: "multiselect", options: " \n " }])).toThrow(/options/)
    expect(() => buildFormFields([{ label: "No key", type: "text" }])).toThrow(/key/)
  })

  it("normalizes stored JSON leniently", () => {
    expect(
      normalizeFields([
        { key: "ok", label: "OK", type: "text", required: true },
        { key: "ok", label: "Duplicate", type: "text" },
        { key: "Bad", label: "Bad", type: "text" },
        { key: "sel", label: "Sel", type: "select", options: [] },
        { key: "t", type: "weird" },
        "junk",
        null,
      ])
    ).toEqual([
      { key: "ok", label: "OK", type: "text", required: true, options: [], help: null },
      { key: "t", label: "t", type: "text", required: false, options: [], help: null },
    ])
    expect(normalizeFields("nope")).toEqual([])
  })
})

describe("request text and tasks", () => {
  const values = { model: "Standard 14\"", device_name: "LAP-0042", qty: 1, needed_by: "2026-12-01", why: "Old one broke\nScreen cracked", policy: true, urgent: false }
  it("builds the subject from the first short text answer", () => {
    expect(requestSubject("New laptop", fields, values)).toBe("New laptop – LAP-0042")
    expect(requestSubject("New laptop", fields, { model: "x" })).toBe("New laptop")
    expect(requestSubject("VPN", [], {})).toBe("VPN")
    expect(requestSubject("X", [], {})).toBe("Request: X")
    expect(requestSubject("Item", fields, { device_name: "y".repeat(200) }).length).toBeLessThanOrEqual(7 + 3 + 80)
  })
  it("summarizes the answers", () => {
    expect(describeAnswers("New laptop", fields, values)).toBe(
      [
        "Requested through the service catalog: New laptop",
        "",
        'Model: Standard 14"',
        "Device name: LAP-0042",
        "Quantity: 1",
        "Needed by: 2026-12-01",
        "Justification:",
        "  Old one broke",
        "  Screen cracked",
        "I accept the policy: Yes",
        "Urgent: No",
      ].join("\n")
    )
  })
  it("parses task templates", () => {
    expect(parseTaskTemplates("Order device\n\n- Image it \n  Hand over")).toEqual([{ title: "Order device" }, { title: "Image it" }, { title: "Hand over" }])
    expect(() => parseTaskTemplates("x\n".repeat(51))).toThrow(/50/)
  })
})
