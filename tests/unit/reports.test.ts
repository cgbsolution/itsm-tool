import { describe, expect, it } from "vitest"
import {
  addDays,
  ageBucketIndex,
  ageingBuckets,
  AGE_THRESHOLDS_HOURS,
  changeSuccess,
  dayStart,
  daysBetween,
  daysSpanned,
  fillSeries,
  formatPercent,
  isYmd,
  localDay,
  monthGrid,
  parseMonth,
  percent,
  resolveRange,
  seriesKeys,
  shiftMonth,
  summarizeSla,
  weekStart,
  weightedMean,
} from "@/lib/reports/helpers"
import { ticketExportRow, ticketFiltersFrom, TICKET_EXPORT_HEADER } from "@/lib/reports/export"
import type { TicketListRow } from "@/lib/itsm/queries"

describe("calendar dates", () => {
  it("validates YYYY-MM-DD", () => {
    expect(isYmd("2026-02-28")).toBe(true)
    expect(isYmd("2026-02-30")).toBe(false)
    expect(isYmd("2026-2-3")).toBe(false)
    expect(isYmd(undefined)).toBe(false)
  })
  it("adds days across months and years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29")
    expect(daysBetween("2026-11-01", "2026-11-30")).toBe(29)
  })
  it("finds the Monday of a week", () => {
    expect(weekStart("2026-11-26")).toBe("2026-11-23") // Thursday
    expect(weekStart("2026-11-23")).toBe("2026-11-23") // Monday
    expect(weekStart("2026-11-29")).toBe("2026-11-23") // Sunday
  })
  it("uses the time zone for day boundaries", () => {
    // 20:00 UTC is already the next day in Kolkata (UTC+5:30)
    expect(localDay(new Date("2026-11-26T20:00:00Z"), "Asia/Kolkata")).toBe("2026-11-27")
    expect(localDay(new Date("2026-11-26T20:00:00Z"), "UTC")).toBe("2026-11-26")
    expect(dayStart("2026-11-27", "Asia/Kolkata").toISOString()).toBe("2026-11-26T18:30:00.000Z")
    expect(dayStart("2026-11-27", "Not/AZone").toISOString()).toBe("2026-11-27T00:00:00.000Z")
  })
})

describe("report range", () => {
  const now = new Date("2026-11-26T10:00:00Z")
  it("defaults to the last 30 days including today", () => {
    const r = resolveRange({}, "UTC", now)
    expect(r.from).toBe("2026-10-28")
    expect(r.to).toBe("2026-11-26")
    expect(r.days).toBe(30)
    expect(r.start.toISOString()).toBe("2026-10-28T00:00:00.000Z")
    expect(r.end.toISOString()).toBe("2026-11-27T00:00:00.000Z")
    expect(r.granularity).toBe("day")
  })
  it("swaps a reversed range and ignores bad dates", () => {
    const r = resolveRange({ from: "2026-11-20", to: "2026-11-01" }, "UTC", now)
    expect([r.from, r.to]).toEqual(["2026-11-01", "2026-11-20"])
    expect(resolveRange({ from: "nonsense", to: "2026-11-10" }, "UTC", now).from).toBe("2026-10-12")
  })
  it("caps the range at two years and switches to weeks for long ranges", () => {
    const r = resolveRange({ from: "2015-01-01", to: "2026-11-26" }, "UTC", now)
    expect(r.days).toBe(731)
    expect(r.granularity).toBe("week")
    expect(resolveRange({ from: "2026-08-01", to: "2026-11-26" }, "UTC", now).granularity).toBe("week")
  })
  it("makes one key per day or per week", () => {
    expect(seriesKeys({ from: "2026-11-01", to: "2026-11-03", granularity: "day" })).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"])
    expect(seriesKeys({ from: "2026-11-04", to: "2026-11-20", granularity: "week" })).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"])
  })
  it("fills missing days with zero", () => {
    expect(fillSeries(["a", "b", "c"], [{ key: "c", n: 2 }, { key: "a", n: 1 }, { key: "zz", n: 9 }])).toEqual([
      { key: "a", n: 1 },
      { key: "b", n: 0 },
      { key: "c", n: 2 },
    ])
  })
})

describe("percentages and means", () => {
  it("rounds to one decimal and handles zero", () => {
    expect(percent(1, 3)).toBe(33.3)
    expect(percent(2, 3)).toBe(66.7)
    expect(percent(5, 5)).toBe(100)
    expect(percent(0, 0)).toBeNull()
    expect(formatPercent(null)).toBe("—")
    expect(formatPercent(50)).toBe("50%")
    expect(formatPercent(33.3)).toBe("33.3%")
  })
  it("weights group means by their counts", () => {
    expect(weightedMean([{ n: 1, mean: 10 }, { n: 3, mean: 30 }])).toBe(25)
    expect(weightedMean([{ n: 0, mean: 10 }, { n: 2, mean: null }])).toBeNull()
  })
})

describe("backlog ageing", () => {
  it("buckets like SQL width_bucket", () => {
    expect(AGE_THRESHOLDS_HOURS).toEqual([24, 72, 168, 720])
    expect(ageBucketIndex(0)).toBe(0)
    expect(ageBucketIndex(23.9)).toBe(0)
    expect(ageBucketIndex(24)).toBe(1)
    expect(ageBucketIndex(71)).toBe(1)
    expect(ageBucketIndex(72)).toBe(2)
    expect(ageBucketIndex(167)).toBe(2)
    expect(ageBucketIndex(168)).toBe(3)
    expect(ageBucketIndex(719)).toBe(3)
    expect(ageBucketIndex(720)).toBe(4)
    expect(ageBucketIndex(100_000)).toBe(4)
  })
  it("labels every bucket, with zeros", () => {
    const b = ageingBuckets([{ bucket: 4, n: 2 }, { bucket: 0, n: 5 }])
    expect(b.map((x) => x.label)).toEqual(["< 1 day", "1–3 days", "3–7 days", "7–30 days", "> 30 days"])
    expect(b.map((x) => x.n)).toEqual([5, 0, 0, 0, 2])
  })
})

describe("SLA compliance", () => {
  it("summarises per kind and per priority", () => {
    const s = summarizeSla(
      [
        { kind: "response", priority: "high", met: 3, breached: 1 },
        { kind: "response", priority: "low", met: 1, breached: 0 },
        { kind: "resolution", priority: "high", met: 1, breached: 1 },
      ],
      ["low", "medium", "high", "critical"]
    )
    expect(s.byKind.response).toEqual({ met: 4, breached: 1, total: 5, pct: 80 })
    expect(s.byKind.resolution).toEqual({ met: 1, breached: 1, total: 2, pct: 50 })
    expect(s.byPriority.high.response.pct).toBe(75)
    expect(s.byPriority.medium.response).toEqual({ met: 0, breached: 0, total: 0, pct: null })
  })
})

describe("change success", () => {
  it("computes the success rate over changes with an outcome", () => {
    const c = changeSuccess([{ outcome: "successful", n: 3 }, { outcome: "failed", n: 1 }])
    expect(c.total).toBe(4)
    expect(c.successRate).toBe(75)
    expect(c.rows.map((r) => r.outcome)).toEqual(["successful", "partially_successful", "failed", "backed_out"])
    expect(c.rows[2]).toEqual({ outcome: "failed", n: 1, pct: 25 })
    expect(changeSuccess([]).successRate).toBeNull()
  })
})

describe("month grid", () => {
  it("parses ?month= or falls back to the current month in the zone", () => {
    expect(parseMonth("2026-02", "UTC")).toEqual({ year: 2026, month: 2 })
    expect(parseMonth("2026-13", "UTC", new Date("2026-11-26T00:00:00Z"))).toEqual({ year: 2026, month: 11 })
    expect(parseMonth(undefined, "Pacific/Kiritimati", new Date("2026-11-30T12:00:00Z"))).toEqual({ year: 2026, month: 12 })
  })
  it("shifts months across years", () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 })
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 })
  })
  it("lays out Monday-first weeks covering the month", () => {
    const g = monthGrid({ year: 2026, month: 11 })
    expect(g[0][0]).toBe("2026-10-26") // 1 Nov 2026 is a Sunday
    expect(g[0][6]).toBe("2026-11-01")
    expect(g[g.length - 1][6]).toBe("2026-12-06")
    expect(g.every((w) => w.length === 7)).toBe(true)
    expect(monthGrid({ year: 2021, month: 2 }).length).toBe(4) // Feb 2021 starts on a Monday, 28 days
  })
  it("lists the days an event touches, clipped to the grid", () => {
    const tz = "UTC"
    expect(daysSpanned(new Date("2026-11-05T22:00:00Z"), new Date("2026-11-07T02:00:00Z"), tz)).toEqual(["2026-11-05", "2026-11-06", "2026-11-07"])
    // ending exactly at midnight does not touch the next day
    expect(daysSpanned(new Date("2026-11-05T22:00:00Z"), new Date("2026-11-06T00:00:00Z"), tz)).toEqual(["2026-11-05"])
    expect(daysSpanned(new Date("2026-11-05T22:00:00Z"), null, tz)).toEqual(["2026-11-05"])
    expect(daysSpanned(new Date("2026-01-01T00:00:00Z"), new Date("2027-01-01T00:00:00Z"), tz, { from: "2026-11-30", to: "2026-12-02" })).toEqual([
      "2026-11-30",
      "2026-12-01",
      "2026-12-02",
    ])
    // the zone decides the day
    expect(daysSpanned(new Date("2026-11-05T20:00:00Z"), new Date("2026-11-05T21:00:00Z"), "Asia/Kolkata")).toEqual(["2026-11-06"])
  })
})

describe("ticket export", () => {
  it("reads the /tickets filters with the same default view", () => {
    const f = ticketFiltersFrom(new URLSearchParams("type=incident&priority=high&q=vpn&bogus=1"))
    expect(f).toMatchObject({ type: "incident", priority: "high", q: "vpn", view: "active" })
    expect("bogus" in f).toBe(false)
    expect(ticketFiltersFrom(new URLSearchParams("view=all")).view).toBe("all")
  })
  it("writes one value per header column", () => {
    const row = {
      id: "x",
      number: "INC0001001",
      ticket_type: "incident",
      status: "new",
      subject: "VPN down",
      priority: "high",
      category: "Network",
      sub_category: null,
      created_at: new Date(),
      updated_at: new Date(),
      sla_resolution_due: null,
      sla_resolution_breached: false,
      sla_response_breached: true,
      requester_name: "Meera",
      assignee_name: null,
      group_name: "Service Desk",
      total: 1,
    } as TicketListRow
    const out = ticketExportRow(row)
    expect(out).toHaveLength(TICKET_EXPORT_HEADER.length)
    expect(out[0]).toBe("INC0001001")
    expect(out[out.length - 1]).toBe("yes")
  })
})
