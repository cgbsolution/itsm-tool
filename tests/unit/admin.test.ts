import { describe, expect, it } from "vitest"
import {
  cleanPermissions,
  fieldKeyProblem,
  list,
  normalizeEmail,
  optionalDomain,
  parseDuration,
  parseHolidays,
  parseOptions,
  parseTicketTypes,
  parseTimeOfDay,
  parseWorkDays,
  permissionGroups,
  placeholdersIn,
  roleKeyProblem,
  splitMinutes,
  wholeNumber,
} from "@/lib/admin/rules"
import { parseCalendar } from "@/lib/admin/itsm"
import { parseWindow } from "@/lib/admin/windows"
import { templatePlaceholders } from "@/lib/admin/templates"
import { DEFAULT_TEMPLATES } from "@/lib/email/templates"

describe("SLA targets (hours + minutes)", () => {
  it("converts hours and minutes to minutes", () => {
    expect(parseDuration("1", "30", "Response")).toBe(90)
    expect(parseDuration("0", "15", "Response")).toBe(15)
    expect(parseDuration("8", "", "Resolution")).toBe(480)
    expect(parseDuration("", "45", "Response")).toBe(45)
    expect(parseDuration(" 24 ", " 0 ", "Resolution")).toBe(1440)
  })
  it("refuses zero, fractions, negatives and minutes over 59", () => {
    expect(() => parseDuration("0", "0", "Response")).toThrow(/at least 1 minute/)
    expect(() => parseDuration("", "", "Response")).toThrow(/at least 1 minute/)
    expect(() => parseDuration("1.5", "0", "Response")).toThrow(/whole number/)
    expect(() => parseDuration("-1", "0", "Response")).toThrow(/whole number/)
    expect(() => parseDuration("1", "60", "Response")).toThrow(/between 0 and 59/)
    expect(() => parseDuration("abc", "0", "Response")).toThrow(/hours/)
  })
  it("caps targets at 365 days (the schema limit)", () => {
    expect(parseDuration("8760", "0", "Resolution")).toBe(525_600)
    expect(() => parseDuration("8760", "1", "Resolution")).toThrow(/8760 hours/)
  })
  it("names the field in the message", () => {
    expect(() => parseDuration("x", "", "Resolution target")).toThrow(/^Resolution target:/)
  })
  it("splits minutes back for the form", () => {
    expect(splitMinutes(90)).toEqual({ hours: 1, minutes: 30 })
    expect(splitMinutes(1440)).toEqual({ hours: 24, minutes: 0 })
    expect(splitMinutes(59)).toEqual({ hours: 0, minutes: 59 })
    for (const n of [1, 61, 525_600]) {
      const s = splitMinutes(n)
      expect(parseDuration(String(s.hours), String(s.minutes), "x")).toBe(n)
    }
  })
})

describe("holidays", () => {
  it("parses one date per line, ignoring names, blanks and comments; sorts and de-duplicates", () => {
    const text = "2026-12-25 Christmas Day\n\n  2026-01-01\tNew Year\n# office closed\n2026-12-25\n2026-08-15 - Independence Day\n2026-10-02, Gandhi Jayanti\r\n"
    expect(parseHolidays(text)).toEqual(["2026-01-01", "2026-08-15", "2026-10-02", "2026-12-25"])
  })
  it("accepts an empty list", () => {
    expect(parseHolidays("")).toEqual([])
    expect(parseHolidays(undefined)).toEqual([])
  })
  it("refuses lines that do not start with a date, with the line number", () => {
    expect(() => parseHolidays("2026-12-25\nChristmas 2026-12-26")).toThrow(/line 2/)
    expect(() => parseHolidays("25/12/2026")).toThrow(/line 1/)
    expect(() => parseHolidays("2026-12-251")).toThrow(/line 1/)
  })
  it("refuses dates that do not exist", () => {
    expect(() => parseHolidays("2026-02-30")).toThrow(/not a real date/)
    expect(() => parseHolidays("2026-13-01")).toThrow(/not a real date/)
    expect(parseHolidays("2028-02-29 leap day")).toEqual(["2028-02-29"])
    expect(() => parseHolidays("2027-02-29")).toThrow(/not a real date/)
  })
})

describe("role keys", () => {
  it("accepts lowercase keys of 2 to 41 characters starting with a letter", () => {
    expect(roleKeyProblem("service_desk_lead")).toBeNull()
    expect(roleKeyProblem("l2")).toBeNull()
    expect(roleKeyProblem("a" + "b".repeat(40))).toBeNull()
  })
  it("refuses bad shapes", () => {
    expect(roleKeyProblem("")).toMatch(/Enter a key/)
    expect(roleKeyProblem("a")).toMatch(/2 to 41/)
    expect(roleKeyProblem("1st_line")).not.toBeNull()
    expect(roleKeyProblem("Service")).not.toBeNull()
    expect(roleKeyProblem("service-desk")).not.toBeNull()
    expect(roleKeyProblem("a" + "b".repeat(41))).not.toBeNull()
  })
  it("refuses the built-in role keys and the system actor", () => {
    for (const k of ["user", "engineer", "admin", "superadmin", "system"]) expect(roleKeyProblem(k)).toMatch(/reserved/)
  })
  it("never lets a custom role hold admin.tenants or unknown permissions", () => {
    expect(cleanPermissions(["ticket.work", "admin.tenants", "nope", "ticket.work", "cmdb.view"])).toEqual(["cmdb.view", "ticket.work"])
    expect(cleanPermissions(undefined)).toEqual([])
    expect(cleanPermissions("report.view")).toEqual(["report.view"])
  })
  it("groups permissions by prefix without admin.tenants", () => {
    const groups = permissionGroups()
    const keys = groups.flatMap((g) => g.items.map((i) => i.key))
    expect(keys).not.toContain("admin.tenants")
    expect(groups.find((g) => g.prefix === "ticket")?.items.length).toBe(5)
    expect(groups.find((g) => g.prefix === "admin")?.label).toBe("Administration")
    expect(permissionGroups({ includeTenants: true }).flatMap((g) => g.items.map((i) => i.key))).toContain("admin.tenants")
  })
})

describe("form values", () => {
  it("parses record types; none or all means every type", () => {
    expect(parseTicketTypes([])).toBeNull()
    expect(parseTicketTypes(["incident", "service_request", "problem", "change"])).toBeNull()
    expect(parseTicketTypes(["change", "incident", "incident"])).toEqual(["incident", "change"])
    expect(() => parseTicketTypes(["incident", "task"])).toThrow(/Unknown record type/)
  })
  it("parses select options", () => {
    expect(parseOptions(" Red \n\nGreen\r\nBlue ")).toEqual(["Red", "Green", "Blue"])
    expect(() => parseOptions("A\nA")).toThrow(/twice/)
  })
  it("parses times and work days", () => {
    expect(parseTimeOfDay("9:00", "Start")).toBe("09:00")
    expect(parseTimeOfDay("18:30:00", "End")).toBe("18:30")
    expect(() => parseTimeOfDay("24:00", "End")).toThrow(/like 09:00/)
    expect(parseWorkDays(["5", "1", "3", "1"])).toEqual([1, 3, 5])
    expect(() => parseWorkDays([])).toThrow(/at least one/)
    expect(() => parseWorkDays(["7"])).toThrow(/unknown day/)
  })
  it("normalises emails and domains", () => {
    expect(normalizeEmail("  Asha@Example.COM ")).toBe("asha@example.com")
    expect(() => normalizeEmail("asha@")).toThrow(/valid email/)
    expect(() => normalizeEmail("")).toThrow(/required/)
    expect(optionalDomain("https://Example.com/")).toBe("example.com")
    expect(optionalDomain("@corp.example.co.uk")).toBe("corp.example.co.uk")
    expect(optionalDomain("")).toBeNull()
    expect(() => optionalDomain("not a domain")).toThrow(/example.com/)
  })
  it("checks whole numbers, custom field keys and repeated values", () => {
    expect(wholeNumber("7", "Days", 0, 365)).toBe(7)
    expect(() => wholeNumber("366", "Days", 0, 365)).toThrow(/between 0 and 365/)
    expect(() => wholeNumber("1.5", "Days", 0, 365)).toThrow(/whole number/)
    expect(fieldKeyProblem("asset_tag")).toBeNull()
    expect(fieldKeyProblem("x")).toBeNull()
    expect(fieldKeyProblem("Asset")).not.toBeNull()
    expect(list(["a", " ", "b"])).toEqual(["a", "b"])
    expect(list("a")).toEqual(["a"])
    expect(list(undefined)).toEqual([])
  })
})

describe("calendar settings", () => {
  const base = {
    timezone: "Asia/Kolkata",
    workDays: ["1", "2", "3", "4", "5"],
    workStart: "09:30",
    workEnd: "18:00",
    holidays: "2026-12-25 Christmas",
    holdMaxHours: "72",
    reopenWindowDays: "7",
    autoCloseResolvedDays: "3",
    strictAssignment: "on",
  }
  it("parses a valid calendar", () => {
    const c = parseCalendar(base)
    expect(c).toMatchObject({ timezone: "Asia/Kolkata", work_days: [1, 2, 3, 4, 5], work_start: "09:30", holidays: ["2026-12-25"], strict_assignment: true })
    expect(parseCalendar({ ...base, strictAssignment: null }).strict_assignment).toBe(false)
  })
  it("refuses unknown time zones and inverted hours", () => {
    expect(() => parseCalendar({ ...base, timezone: "Mars/Olympus" })).toThrow(/Unknown time zone/)
    expect(() => parseCalendar({ ...base, workEnd: "09:00" })).toThrow(/end after it starts/)
    expect(() => parseCalendar({ ...base, holdMaxHours: "0" })).toThrow(/between 1 and 8760/)
  })
})

describe("maintenance windows", () => {
  const base = { name: "Sunday patching", kind: "maintenance", appliesTo: "patches", startsAt: "2026-12-06T02:00", endsAt: "2026-12-06T04:00", recurrence: "weekly" }
  it("reads datetime-local values in the tenant time zone", () => {
    const w = parseWindow(base, "Asia/Kolkata")
    expect(w.starts_at.toISOString()).toBe("2026-12-05T20:30:00.000Z")
    expect(w.ends_at.getTime() - w.starts_at.getTime()).toBe(2 * 3600_000)
    expect(w.recurrence_until).toBeNull()
  })
  it("refuses an end before the start and windows longer than their period", () => {
    expect(() => parseWindow({ ...base, endsAt: "2026-12-06T01:00" }, "UTC")).toThrow(/end after it starts/)
    expect(() => parseWindow({ ...base, recurrence: "daily", endsAt: "2026-12-07T03:00" }, "UTC")).toThrow(/longer than its period/)
    expect(() => parseWindow({ ...base, recurrenceUntil: "2026-12-01T00:00" }, "UTC")).toThrow(/Repeat until/)
    expect(() => parseWindow({ ...base, kind: "freeze" }, "UTC")).toThrow()
  })
})

describe("email template placeholders", () => {
  it("lists the placeholders of the default text plus recipient and brand", () => {
    const p = templatePlaceholders("user.invite")
    expect(p).toEqual(expect.arrayContaining(["recipient.name", "brand.name", "link", "hours"]))
    expect(templatePlaceholders("nope")).toEqual([])
    for (const key of Object.keys(DEFAULT_TEMPLATES)) expect(templatePlaceholders(key)).toContain("brand.name")
  })
  it("extracts placeholders from text", () => {
    expect(placeholdersIn("Hi {{ recipient.name }}, see {{ticket.url}} {{ticket.url}}")).toEqual(["recipient.name", "ticket.url"])
  })
})
