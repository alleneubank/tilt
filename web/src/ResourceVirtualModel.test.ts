import {
  buildSidebarVirtualModel,
  resourceEntriesInOrder,
} from "./ResourceVirtualModel"

type Item = {
  name: string
  labels: string[]
  disabled?: boolean
  tiltfile?: boolean
}

describe("buildSidebarVirtualModel", () => {
  it("keeps duplicate multi-label occurrences and complete group membership", () => {
    const model = buildSidebarVirtualModel<Item>({
      items: [
        { name: "api", labels: ["frontend", "backend"] },
        { name: "worker", labels: ["backend"] },
      ],
      isDisabled: (item) => !!item.disabled,
      isTiltfile: (item) => !!item.tiltfile,
      groupState: { frontend: true, backend: true },
    })

    expect(
      resourceEntriesInOrder(model.entries).map((entry) => entry.occurrenceKey)
    ).toEqual([
      "label:backend:api",
      "label:backend:worker",
      "label:frontend:api",
    ])
    expect(model.groups.get("label:backend")?.members).toHaveLength(2)
  })

  it("keeps disabled structure after enabled occurrences", () => {
    const model = buildSidebarVirtualModel<Item>({
      items: [
        { name: "enabled", labels: [] },
        { name: "disabled", labels: [], disabled: true },
      ],
      isDisabled: (item) => !!item.disabled,
      isTiltfile: (item) => !!item.tiltfile,
      groupState: {},
    })

    expect(model.entries.map((entry) => entry.kind)).toEqual([
      "group-header",
      "resource",
      "disabled-header",
      "resource",
    ])
  })

  it("assigns leading and continuation layout classes within each enabled and disabled section", () => {
    const model = buildSidebarVirtualModel<Item>({
      items: [
        { name: "enabled-leading", labels: [] },
        { name: "enabled-continuation", labels: [] },
        { name: "disabled-leading", labels: [], disabled: true },
        { name: "disabled-continuation", labels: [], disabled: true },
      ],
      isDisabled: (item) => !!item.disabled,
      isTiltfile: (item) => !!item.tiltfile,
      groupState: {},
      layoutKeyForItem: (_item, section, flow) => `${section}-${flow}`,
    })

    expect(
      resourceEntriesInOrder(model.entries).map((entry) => ({
        layoutKey: entry.layoutKey,
        flow: entry.flow,
      }))
    ).toEqual([
      { layoutKey: "enabled-leading", flow: "leading" },
      { layoutKey: "enabled-continuation", flow: "continuation" },
      { layoutKey: "disabled-leading", flow: "leading" },
      { layoutKey: "disabled-continuation", flow: "continuation" },
    ])
  })

  it("assigns separate non-empty layout classes to group, Tiltfile, and disabled structure", () => {
    const model = buildSidebarVirtualModel<Item>({
      items: [
        { name: "labeled", labels: ["team"] },
        { name: "Tiltfile", labels: [], tiltfile: true },
        { name: "disabled", labels: [], disabled: true },
      ],
      isDisabled: (item) => !!item.disabled,
      isTiltfile: (item) => !!item.tiltfile,
      groupState: {},
    })

    expect(
      model.entries
        .filter((entry) => entry.kind !== "resource")
        .map((entry) => entry.layoutKey)
    ).toEqual([
      "group-header",
      "group-header",
      "disabled-header",
      "tiltfile-header",
    ])
  })

  it("allows each surface to opt into collapsible Tiltfile headers and expanded header geometry", () => {
    const model = buildSidebarVirtualModel<Item>({
      items: [
        { name: "labeled", labels: ["team"] },
        { name: "Tiltfile", labels: [], tiltfile: true },
      ],
      isDisabled: (item) => !!item.disabled,
      isTiltfile: (item) => !!item.tiltfile,
      groupState: { team: false, Tiltfile: true },
      groupCollapsible: () => true,
      groupHeaderLayoutKey: (_group, expanded) =>
        `overview-group-header-${expanded ? "expanded" : "collapsed"}`,
    })

    const headers = model.entries.filter(
      (entry): entry is Extract<typeof entry, { kind: "group-header" }> =>
        entry.kind === "group-header"
    )
    expect(headers.map((entry) => [entry.groupId, entry.collapsible])).toEqual([
      ["label:team", true],
      ["tiltfile", true],
    ])
    expect(headers.map((entry) => entry.layoutKey)).toEqual([
      "overview-group-header-collapsed",
      "overview-group-header-expanded",
    ])
  })

  it("hides collapsed-group disabled headers and keeps unlabeled collapsible", () => {
    const model = buildSidebarVirtualModel<Item>({
      items: [
        { name: "hidden", labels: ["collapsed"], disabled: true },
        { name: "plain", labels: [] },
        { name: "Tiltfile", labels: [], tiltfile: true },
      ],
      isDisabled: (item) => !!item.disabled,
      isTiltfile: (item) => !!item.tiltfile,
      groupState: { collapsed: false, unlabeled: false },
      selectedName: "",
    })

    expect(model.entries.map((entry) => entry.kind)).toEqual([
      "group-header",
      "group-header",
      "group-header",
      "resource",
    ])
    expect(
      model.entries.find((entry) => entry.kind === "disabled-header")
    ).toBeUndefined()
    expect(model.groups.get("ungrouped")?.expanded).toBe(false)
    expect(model.logicalResources.map((entry) => entry.resourceName)).toEqual([
      "hidden",
      "plain",
      "Tiltfile",
    ])
  })

  it("rejects a label sorter that is not an exact group permutation", () => {
    expect(() =>
      buildSidebarVirtualModel<Item>({
        items: [
          { name: "api", labels: ["api"] },
          { name: "web", labels: ["web"] },
        ],
        isDisabled: () => false,
        isTiltfile: () => false,
        groupState: {},
        sortLabels: () => ["api", "api"],
      })
    ).toThrow("exact group permutation")
  })

  it("rejects empty names", () => {
    expect(() =>
      buildSidebarVirtualModel<Item>({
        items: [{ name: "", labels: [] }],
        isDisabled: () => false,
        isTiltfile: () => false,
        groupState: {},
      })
    ).toThrow("resource name")
  })
})
