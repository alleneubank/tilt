import {
  computeResourceVirtualRange,
  RESOURCE_VIRTUAL_OVERSCAN_VIEWPORTS,
} from "./ResourceVirtualRange"
import { ResourceVirtualEntry } from "./ResourceVirtualModel"

const entries: ReadonlyArray<ResourceVirtualEntry<string>> = Array.from(
  { length: 100 },
  (_, index) => ({
    kind: "resource" as const,
    occurrenceKey: `resource:${index}`,
    resourceName: `resource-${index}`,
    groupId: "ungrouped",
    item: `resource-${index}`,
    resourceIndex: index,
    groupIndex: index,
    layoutKey: "default",
  })
)

describe("computeResourceVirtualRange", () => {
  it("bounds mounted resources to the visible viewport and one viewport on each side", () => {
    const range = computeResourceVirtualRange(entries, {
      viewportHeight: 100,
      scrollTop: 500,
      resourceHeights: new Map([["default", 20]]),
      structuralHeights: new Map(),
    })

    expect(range.resourceCapacity).toBe(5)
    expect(range.resourceBound).toBe(
      5 * (1 + RESOURCE_VIRTUAL_OVERSCAN_VIEWPORTS * 2)
    )
    expect(
      range.entries.filter((entry) => entry.kind === "resource").length
    ).toBeLessThanOrEqual(15)
    expect(range.beforeSpacer).toBeGreaterThan(0)
  })

  it("covers the complete visible mixed-height viewport before applying its median bound", () => {
    const mixed: ReadonlyArray<ResourceVirtualEntry<string>> = [
      ...Array.from({ length: 27 }, (_, index) => ({
        ...entries[index],
        layoutKey: "enabled",
      })),
      ...Array.from({ length: 80 }, (_, index) => ({
        ...entries[index + 20],
        occurrenceKey: `disabled:${index}`,
        resourceIndex: index + 27,
        layoutKey: "disabled",
      })),
    ]
    ;[1750, 2500, 3200].forEach((scrollTop) => {
      const range = computeResourceVirtualRange(mixed, {
        viewportHeight: 818,
        scrollTop,
        resourceHeights: new Map([
          ["enabled", 66],
          ["disabled", 29],
        ]),
        structuralHeights: new Map(),
      })
      const renderedHeight = range.entries.reduce(
        (height, entry) =>
          height +
          (entry.kind === "resource"
            ? entry.layoutKey === "enabled"
              ? 66
              : 29
            : 20),
        0
      )
      const renderedBottom = range.beforeSpacer + renderedHeight
      const visibleBottom = Math.min(range.totalHeight, scrollTop + 818)
      const mountedHeights = range.entries
        .filter(
          (
            entry
          ): entry is Extract<typeof mixed[number], { kind: "resource" }> =>
            entry.kind === "resource"
        )
        .map((entry) => (entry.layoutKey === "enabled" ? 66 : 29))
        .sort((left, right) => left - right)
      const median = mountedHeights[Math.floor(mountedHeights.length / 2)]

      expect(range.beforeSpacer).toBeLessThanOrEqual(scrollTop)
      expect(renderedBottom).toBeGreaterThanOrEqual(visibleBottom)
      expect(mountedHeights.length).toBeLessThanOrEqual(
        Math.ceil(818 / median) * 3
      )
      expect(range.resourceCapacity).toBe(Math.ceil(818 / median))
      expect(range.resourceBound).toBe(Math.ceil(818 / median) * 3)
    })

    const target = computeResourceVirtualRange(mixed, {
      viewportHeight: 818,
      scrollTop: 0,
      resourceHeights: new Map([
        ["enabled", 66],
        ["disabled", 29],
      ]),
      structuralHeights: new Map(),
      targetKey: "disabled:70",
    })
    expect(
      target.entries.some(
        (entry) =>
          entry.kind === "resource" && entry.occurrenceKey === "disabled:70"
      )
    ).toBe(true)
  })

  it("fails closed until every resource layout has positive geometry", () => {
    const mixed = [{ ...entries[0], layoutKey: "enabled" }]
    expect(() =>
      computeResourceVirtualRange(mixed, {
        viewportHeight: 100,
        scrollTop: 0,
        resourceHeights: new Map(),
        structuralHeights: new Map(),
      })
    ).toThrow("Missing resource measurement for layout enabled")
  })

  it("does not reuse an exact occurrence measurement after that occurrence changes layout", () => {
    const continuation = Array.from({ length: 100 }, (_, index) => ({
      ...entries[index],
      layoutKey: "enabled-continuation",
    }))
    const staleLeadingExact = new Map(
      continuation.map((entry) => {
        if (entry.kind !== "resource")
          throw new Error("Expected resource continuation")
        return [`${entry.occurrenceKey}::enabled-leading`, 54.8]
      })
    )

    const range = computeResourceVirtualRange(continuation, {
      viewportHeight: 818,
      scrollTop: 0,
      resourceHeights: new Map([["enabled-continuation", 66]]),
      structuralHeights: new Map(),
      entryHeights: staleLeadingExact,
    })

    expect(range.resourceBound).toBe(39)
    expect(
      range.entries.filter((entry) => entry.kind === "resource").length
    ).toBeLessThanOrEqual(39)
  })

  it("uses each structural layout class for total flow and far-target offsets", () => {
    const mixedStructural: ReadonlyArray<ResourceVirtualEntry<string>> = [
      {
        kind: "group-header",
        groupId: "group",
        label: "Group",
        expanded: true,
        members: [],
        memberCount: 0,
        collapsible: true,
        layoutKey: "group-header",
      },
      {
        kind: "group-header",
        groupId: "tiltfile",
        label: "Tiltfile",
        expanded: true,
        members: [],
        memberCount: 0,
        collapsible: false,
        layoutKey: "tiltfile-header",
      },
      {
        kind: "disabled-header",
        sectionId: "disabled:group",
        groupId: "group",
        memberCount: 1,
        layoutKey: "disabled-header",
      },
      { ...entries[0], layoutKey: "enabled-leading" },
    ]
    const range = computeResourceVirtualRange(mixedStructural, {
      viewportHeight: 50,
      scrollTop: 0,
      resourceHeights: new Map([["enabled-leading", 60]]),
      structuralHeights: new Map([
        ["group-header", 20],
        ["tiltfile-header", 30],
        ["disabled-header", 40],
      ]),
      targetKey: "resource:0",
    })

    expect(range.totalHeight).toBe(150)
    expect(range.anchorAdjustment).toBe(90)
    expect(
      range.beforeSpacer +
        range.entries.reduce(
          (sum, entry) =>
            sum +
            (entry.kind === "resource"
              ? 60
              : entry.layoutKey === "group-header"
              ? 20
              : entry.layoutKey === "tiltfile-header"
              ? 30
              : 40),
          0
        ) +
        range.afterSpacer
    ).toBe(150)
  })

  it("brings a far target into the range instead of appending it", () => {
    const range = computeResourceVirtualRange(entries, {
      viewportHeight: 100,
      scrollTop: 0,
      resourceHeights: new Map([["default", 20]]),
      structuralHeights: new Map(),
      targetKey: "resource:99",
    })

    expect(
      range.entries.some(
        (entry) =>
          entry.kind === "resource" && entry.occurrenceKey === "resource:99"
      )
    ).toBe(true)
    expect(
      range.entries.filter((entry) => entry.kind === "resource").length
    ).toBeLessThanOrEqual(15)
  })

  it("clamps a far-tail target to the browser's achievable scroll range", () => {
    const range = computeResourceVirtualRange(entries.slice(0, 3), {
      viewportHeight: 40,
      scrollTop: 0,
      resourceHeights: new Map([["default", 20]]),
      structuralHeights: new Map(),
      targetKey: "resource:2",
    })

    expect(range.anchorAdjustment).toBe(20)
    expect(range.anchorAdjustment).toBeLessThanOrEqual(range.totalHeight - 40)
  })

  it("uses nearest target positioning without moving an already visible target", () => {
    const range = computeResourceVirtualRange(entries, {
      viewportHeight: 100,
      scrollTop: 40,
      resourceHeights: new Map([["default", 20]]),
      structuralHeights: new Map(),
      targetKey: "resource:3",
    })

    expect(range.anchorAdjustment).toBe(0)
    expect(range.scrollTop).toBe(40)
  })

  it("uses a signed list-local viewport below fixed owner chrome", () => {
    const signedInput = {
      viewportHeight: 818,
      scrollTop: -130,
      minimumScrollTop: -130,
      resourceHeights: new Map([["default", 66]]),
      structuralHeights: new Map(),
    }

    const belowFold = computeResourceVirtualRange(entries, {
      ...signedInput,
      targetKey: "resource:11",
    })
    expect(belowFold.scrollTop).toBe(-130)
    expect(belowFold.anchorAdjustment).toBe(104)

    const partiallyVisible = computeResourceVirtualRange(entries, {
      ...signedInput,
      scrollTop: -100,
      targetKey: "resource:0",
    })
    expect(partiallyVisible.anchorAdjustment).toBe(0)

    const afterChrome = computeResourceVirtualRange(entries, {
      ...signedInput,
      scrollTop: 20,
      targetKey: "resource:1",
    })
    expect(afterChrome.anchorAdjustment).toBe(0)

    const shortList = computeResourceVirtualRange(entries.slice(0, 3), {
      ...signedInput,
      targetKey: "resource:2",
    })
    expect(shortList.anchorAdjustment).toBe(0)
  })

  it("uses nearest target edges above, below, and taller than the viewport", () => {
    const input = {
      viewportHeight: 100,
      scrollTop: 40,
      resourceHeights: new Map([["default", 20]]),
      structuralHeights: new Map(),
    }

    expect(
      computeResourceVirtualRange(entries, {
        ...input,
        targetKey: "resource:0",
      }).anchorAdjustment
    ).toBe(-40)
    expect(
      computeResourceVirtualRange(entries, {
        ...input,
        targetKey: "resource:8",
      }).anchorAdjustment
    ).toBe(40)
    expect(
      computeResourceVirtualRange(entries, {
        ...input,
        targetKey: "resource:3",
        entryHeights: new Map([["resource:3::default", 140]]),
      }).anchorAdjustment
    ).toBe(20)
  })

  it("handles empty and structural-only sequences without inventing a resource capacity", () => {
    const empty = computeResourceVirtualRange([], {
      viewportHeight: 100,
      scrollTop: 0,
      resourceHeights: new Map(),
      structuralHeights: new Map(),
    })
    const structural: ReadonlyArray<ResourceVirtualEntry<string>> = [
      {
        kind: "group-header",
        groupId: "group",
        label: "Group",
        expanded: true,
        members: [],
        memberCount: 0,
        collapsible: true,
        layoutKey: "group-header",
      },
    ]
    const structuralOnly = computeResourceVirtualRange(structural, {
      viewportHeight: 100,
      scrollTop: 0,
      resourceHeights: new Map(),
      structuralHeights: new Map([["group-header", 20]]),
    })

    expect(empty).toMatchObject({
      entries: [],
      resourceCapacity: 0,
      resourceBound: 0,
      totalHeight: 0,
    })
    expect(structuralOnly).toMatchObject({
      entries: structural,
      resourceCapacity: 0,
      resourceBound: 0,
      totalHeight: 20,
    })
  })

  it("does not retain an unmounted resource below a structural-only viewport", () => {
    const structuralViewport: ReadonlyArray<ResourceVirtualEntry<string>> = [
      ...Array.from({ length: 100 }, (_, index) => ({
        kind: "group-header" as const,
        groupId: `group-${index}`,
        label: `Group ${index}`,
        expanded: true,
        members: [],
        memberCount: 0,
        collapsible: true,
        layoutKey: "group-header",
      })),
      {
        kind: "resource" as const,
        occurrenceKey: "tail",
        resourceName: "tail",
        groupId: "tail",
        item: "tail",
        resourceIndex: 0,
        groupIndex: 0,
        layoutKey: "default",
      },
    ]

    const range = computeResourceVirtualRange(structuralViewport, {
      viewportHeight: 100,
      scrollTop: 0,
      resourceHeights: new Map([["default", 20]]),
      structuralHeights: new Map([["group-header", 20]]),
    })

    expect(range.entries).toEqual(structuralViewport.slice(0, 10))
    expect(range.visibleResource).toBeUndefined()
  })

  it("reports and retains a measured logical anchor across inserted rows", () => {
    const initial = computeResourceVirtualRange(entries, {
      viewportHeight: 100,
      scrollTop: 105,
      resourceHeights: new Map([["default", 20]]),
      structuralHeights: new Map(),
      entryHeights: new Map([["resource:5::default", 30]]),
    })
    expect(initial.visibleResource).toEqual({
      occurrenceKey: "resource:5",
      resourceIndex: 5,
      offset: -5,
    })
    const inserted: ResourceVirtualEntry<string> = {
      kind: "group-header",
      groupId: "new",
      label: "New",
      expanded: true,
      members: [],
      memberCount: 0,
      collapsible: true,
      layoutKey: "group-header",
    }
    const retained = computeResourceVirtualRange([inserted, ...entries], {
      viewportHeight: 100,
      scrollTop: 105,
      resourceHeights: new Map([["default", 20]]),
      structuralHeights: new Map([["group-header", 20]]),
      entryHeights: new Map([["resource:5::default", 30]]),
      retainedAnchor: initial.visibleResource,
    })
    expect(retained.anchorAdjustment).toBe(20)
    expect(retained.visibleResource).toEqual(initial.visibleResource)
  })

  it("falls back to the nearest logical resource when an anchor is removed", () => {
    const retained = computeResourceVirtualRange(
      entries.filter((_, i) => i !== 5),
      {
        viewportHeight: 100,
        scrollTop: 100,
        resourceHeights: new Map([["default", 20]]),
        structuralHeights: new Map(),
        retainedAnchor: {
          occurrenceKey: "resource:5",
          resourceIndex: 5,
          offset: 0,
        },
      }
    )
    expect(retained.visibleResource?.occurrenceKey).toBe("resource:4")
  })

  it("rejects invalid viewport geometry", () => {
    expect(() =>
      computeResourceVirtualRange(entries, {
        viewportHeight: 0,
        scrollTop: 0,
        resourceHeights: new Map([["default", 20]]),
        structuralHeights: new Map(),
      })
    ).toThrow("viewportHeight")
  })
})
