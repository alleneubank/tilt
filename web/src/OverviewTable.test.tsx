import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SnackbarProvider } from "notistack"
import React, { ReactElement } from "react"
import { MemoryRouter } from "react-router"
import { ApiButtonRoot } from "./ApiButton"
import Features, { FeaturesTestProvider, Flag } from "./feature"
import { GroupByLabelView, TILTFILE_LABEL, UNLABELED_LABEL } from "./labels"
import LogStore from "./LogStore"
import OverviewTable, {
  labeledResourcesToTableCells,
  NoMatchesFound,
  ResourceResultCount,
  ResourceTableData,
  ResourceTableHeaderSortTriangle,
  ResourceTableRow,
  requireOverviewEntryIndex,
  requireOverviewResource,
} from "./OverviewTable"
import {
  COLUMNS,
  Name,
  RowValues,
  SelectionCheckbox,
} from "./OverviewTableColumns"
import { ToggleTriggerModeTooltip } from "./OverviewTableTriggerModeToggle"
import {
  DEFAULT_GROUP_STATE,
  GroupsState,
  ResourceGroupsContextProvider,
} from "./ResourceGroupsContext"
import {
  DEFAULT_OPTIONS,
  ResourceListOptions,
  ResourceListOptionsProvider,
} from "./ResourceListOptionsContext"
import { matchesResourceName } from "./ResourceNameFilter"
import { ResourceSelectionProvider } from "./ResourceSelectionContext"
import { ResourceStatusSummaryRoot } from "./ResourceStatusSummary"
import {
  nResourceView,
  nResourceWithLabelsView,
  oneResource,
  oneUIButton,
  TestDataView,
} from "./testdata"
import { RuntimeStatus, TriggerMode, UpdateStatus } from "./types"

// Helpers
const tableViewWithSettings = ({
  view,
  labelsEnabled,
  resourceListOptions,
  resourceSelections,
  groupsState,
}: {
  view: TestDataView
  labelsEnabled?: boolean
  resourceListOptions?: ResourceListOptions
  resourceSelections?: string[]
  groupsState?: GroupsState
}) => {
  const features = new Features({
    [Flag.Labels]: labelsEnabled ?? true,
  })
  return (
    <MemoryRouter
      initialEntries={["/"]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <SnackbarProvider>
        <FeaturesTestProvider value={features}>
          <ResourceGroupsContextProvider initialValuesForTesting={groupsState}>
            <ResourceListOptionsProvider
              initialValuesForTesting={resourceListOptions}
            >
              <ResourceSelectionProvider
                initialValuesForTesting={resourceSelections}
              >
                <OverviewTable view={view} />
              </ResourceSelectionProvider>
            </ResourceListOptionsProvider>
          </ResourceGroupsContextProvider>
        </FeaturesTestProvider>
      </SnackbarProvider>
    </MemoryRouter>
  )
}

const findTableHeaderByName = (columnName: string, sortable = true): any => {
  const selector = sortable ? `Sort by ${columnName}` : columnName
  return screen.getAllByTitle(selector)[0]
}

class OverviewResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  disconnect() {}
  unobserve() {}
}

const overviewClientHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight"
)
const overviewRect = HTMLElement.prototype.getBoundingClientRect

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 1000,
  })
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ height: 20, top: 0 } as DOMRect)
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: OverviewResizeObserver,
  })
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0)
    return null as unknown as number
  })
})

afterAll(() => {
  jest.restoreAllMocks()
  if (overviewClientHeight)
    Object.defineProperty(
      HTMLElement.prototype,
      "clientHeight",
      overviewClientHeight
    )
  HTMLElement.prototype.getBoundingClientRect = overviewRect
})

// End helpers

afterEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

it("uses one bounded overview resource window across label groups", () => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 20,
  })

  const { container } = render(
    tableViewWithSettings({ view: nResourceWithLabelsView(100) })
  )
  const owner = container.querySelector('[aria-label="Resources overview"]')
  const resources = container.querySelectorAll('tbody tr[tabindex="-1"]')

  expect(owner).toHaveStyle({ overflowY: "auto" })
  expect(resources.length).toBeLessThanOrEqual(3)

  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 1000,
  })
})

it("uses one native column model and table-valid grouped headers", () => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 20,
  })

  const view = nResourceWithLabelsView(100)
  const projection = labeledResourcesToTableCells(
    view.uiResources,
    view.uiButtons,
    new LogStore()
  )
  const { container } = render(tableViewWithSettings({ view }))
  try {
    const table = container.querySelector("table")!
    const columns = Array.from(table.querySelectorAll("colgroup > col"))
    const resourceRows = Array.from(
      container.querySelectorAll("tr[data-occurrence-key]")
    )
    const groupCount =
      projection.labels.length +
      Number(projection.unlabeled.length > 0) +
      Number(projection.tiltfile.length > 0)
    const resourceCount =
      projection.labels.reduce(
        (count, label) => count + projection.labelsToResources[label].length,
        0
      ) +
      projection.unlabeled.length +
      projection.tiltfile.length

    expect(getComputedStyle(table).borderCollapse).toBe("separate")
    expect(parseFloat(getComputedStyle(table).borderSpacing)).toBe(0)
    expect(columns).toHaveLength(COLUMNS.length)
    expect(columns.map((column) => column.getAttribute("style"))).toEqual(
      COLUMNS.map((column) => `width: ${column.width};`)
    )
    expect(table).toHaveAttribute(
      "aria-rowcount",
      String(1 + groupCount * 2 + resourceCount)
    )
    expect(table.querySelector("thead tr")).toHaveAttribute(
      "aria-rowindex",
      "1"
    )
    expect(resourceRows.length).toBeGreaterThan(0)
    resourceRows.forEach((row) => {
      expect(getComputedStyle(row).borderTopWidth || "0px").toBe("0px")
      Array.from(row.querySelectorAll("td")).forEach((cell) => {
        expect(getComputedStyle(cell).borderTopWidth).toBe("1px")
        expect(getComputedStyle(cell).borderTopStyle).toBe("solid")
      })
    })
    const semanticHeaders = Array.from(
      table.querySelectorAll("thead th[scope='col']")
    )
    expect(semanticHeaders).toHaveLength(COLUMNS.length)
    expect(table.querySelector("thead input")).toBeNull()
    Array.from(table.querySelectorAll("tbody")).forEach((body) =>
      Array.from(body.querySelectorAll("th[scope='col']")).forEach((header) => {
        expect(header.parentElement?.tagName).toBe("TR")
        expect(header.parentElement?.parentElement).toBe(body)
      })
    )
    expect(
      table.querySelectorAll('td [role="columnheader"], td [role="row"]')
    ).toHaveLength(0)
  } finally {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 1000,
    })
  }
})

it("keeps each mounted group header and controlled resources in sibling rowgroups", () => {
  const { container } = render(
    tableViewWithSettings({ view: nResourceWithLabelsView(8) })
  )

  const controls = Array.from(
    container.querySelectorAll<HTMLElement>(
      "[role='button'][aria-controls^='overview-group-']"
    )
  )
  expect(controls.length).toBeGreaterThan(0)
  controls.forEach((control) => {
    const rowgroup = document.getElementById(
      control.getAttribute("aria-controls")!
    )
    expect(rowgroup).not.toBeNull()
    expect(rowgroup?.getAttribute("role")).toBe("rowgroup")
    expect(rowgroup?.contains(control)).toBe(false)
    expect(rowgroup?.previousElementSibling).toHaveAttribute(
      "data-overview-group-header",
      control.closest("tbody")?.getAttribute("data-overview-group-header")
    )
  })
})

it("uses visible labels for grouped rowgroups and Resources when grouping is disabled", () => {
  const groupedView = nResourceWithLabelsView(8)
  const grouped = render(tableViewWithSettings({ view: groupedView }))
  const projection = labeledResourcesToTableCells(
    groupedView.uiResources,
    groupedView.uiButtons,
    new LogStore()
  )
  const expectedNames = new Map<string, string[]>([
    ...projection.labels.map(
      (label) =>
        [
          `${label} resources`,
          projection.labelsToResources[label].map((resource) => resource.name),
        ] as const
    ),
    [
      `${UNLABELED_LABEL} resources`,
      projection.unlabeled.map((resource) => resource.name),
    ] as const,
    [
      `${TILTFILE_LABEL} resources`,
      projection.tiltfile.map((resource) => resource.name),
    ] as const,
  ])
  const actualNames = new Map(
    Array.from(
      grouped.container.querySelectorAll<HTMLTableSectionElement>(
        'tbody[role="rowgroup"]'
      )
    ).map((rowgroup) => [
      rowgroup.getAttribute("aria-label")!,
      Array.from(rowgroup.querySelectorAll(Name)).map(
        (name) => name.textContent
      ),
    ])
  )

  expect(actualNames).toEqual(expectedNames)
  grouped.unmount()
  sessionStorage.clear()

  const filtered = render(
    tableViewWithSettings({
      view: groupedView,
      resourceListOptions: {
        ...DEFAULT_OPTIONS,
        resourceNameFilter: "a_failed_build",
      },
    })
  )
  expect(
    filtered.container.querySelector('tbody[role="rowgroup"]')
  ).toHaveAttribute("aria-label", "Resources")
})

it("restores grouped panel surfaces within the single virtual table", () => {
  const { container } = render(
    tableViewWithSettings({ view: nResourceWithLabelsView(8) })
  )
  const groupBody = container.querySelector<HTMLTableSectionElement>(
    'tbody[role="rowgroup"]'
  )!
  const headerBody = groupBody.previousElementSibling as HTMLTableSectionElement
  const summary = headerBody.querySelector<HTMLElement>(
    ".overviewGroupSummary"
  )!
  const headerCell = headerBody.querySelector<HTMLElement>(
    ".overviewGroupHeaderCell"
  )!
  const spacer = headerBody.querySelector<HTMLTableCellElement>(
    ".overviewGroupSpacerCell"
  )!
  const lastResource = groupBody.querySelector<HTMLElement>(
    "tr.isOverviewGroupLastResource"
  )!
  const columnHeaders = Array.from(
    headerBody.querySelectorAll<HTMLElement>("th[scope='col']")
  )

  expect(groupBody).toHaveClass("overviewGroupBody", "isExpanded")
  expect(summary).toHaveStyle({
    alignItems: "center",
    backgroundColor: "rgb(0, 27, 32)",
    display: "flex",
    paddingTop: "4px",
  })
  expect(headerCell).toHaveStyle({ borderLeftWidth: "1px" })
  expect(spacer).toHaveAttribute("aria-hidden", "true")
  expect(spacer).toHaveStyle({ height: "16px", backgroundColor: "transparent" })
  expect(columnHeaders).toHaveLength(COLUMNS.length)
  columnHeaders.forEach((header) => {
    expect(getComputedStyle(header).backgroundColor).toBe("rgb(0, 27, 32)")
  })
  expect(getComputedStyle(columnHeaders[0]).borderLeft).toBe(
    "1px solid #2D4D55"
  )
  expect(
    getComputedStyle(columnHeaders[columnHeaders.length - 1]).borderRight
  ).toBe("1px solid #2D4D55")
  expect(lastResource).toHaveClass("isOverviewGroupLastResource")
  Array.from(lastResource.querySelectorAll<HTMLTableCellElement>("td")).forEach(
    (cell) => {
      expect(getComputedStyle(cell).borderBottomWidth).toBe("")
      expect(getComputedStyle(cell).boxShadow).toBe("inset 0 -1px 0 #2D4D55")
    }
  )
})

it("paints selected and focused overview panel cells after their panel fill", () => {
  const { container } = render(
    tableViewWithSettings({
      view: nResourceWithLabelsView(8),
      resourceSelections: ["(Tiltfile)"],
    })
  )

  const selectedCell =
    container.querySelector<HTMLTableCellElement>("tr.isSelected td")!
  expect(getComputedStyle(selectedCell).backgroundColor).toBe("rgb(7, 54, 66)")

  fireEvent.keyDown(document.body, { key: "j" })
  const focusedCell = container.querySelector<HTMLTableCellElement>(
    "tr.isFocused td:first-child"
  )!
  expect(getComputedStyle(focusedCell).borderLeft).toBe("4px solid #03c7d3")
  expect(getComputedStyle(focusedCell).paddingLeft).toBe("20px")
})

it("keeps grouped overview summaries and controls scoped to each expanded group", () => {
  const view = nResourceView(4)
  view.uiResources[1].metadata!.labels = { alpha: "alpha" }
  view.uiResources[2].metadata!.labels = { beta: "beta" }
  const { container } = render(tableViewWithSettings({ view }))
  const alpha = container
    .querySelector<HTMLElement>('tr[data-group-id="label:alpha"]')!
    .closest("tbody")!
  const summary = alpha.querySelector<HTMLElement>(".overviewGroupSummary")!

  expect(summary).toHaveStyle({
    fontSize: "20px",
    marginTop: "0px",
    paddingTop: "4px",
    color: "rgb(255, 255, 255)",
  })
  expect(
    alpha.querySelectorAll('[aria-label="Resource group selection"]')
  ).toHaveLength(1)
  expect(alpha.querySelectorAll('th[scope="col"]')).toHaveLength(COLUMNS.length)
  expect(container.querySelectorAll("table")).toHaveLength(1)

  userEvent.click(summary)
  expect(summary).toHaveAttribute("aria-expanded", "false")
  expect(
    alpha.querySelectorAll('[aria-label="Resource group selection"]')
  ).toHaveLength(0)
  expect(alpha.querySelectorAll('th[scope="col"]')).toHaveLength(0)

  fireEvent.keyDown(summary, { key: "Enter" })
  expect(summary).toHaveAttribute("aria-expanded", "true")
  const expandedAlpha = container
    .querySelector<HTMLElement>('tr[data-group-id="label:alpha"]')!
    .closest("tbody")!
  const alphaSelection = expandedAlpha.querySelector<HTMLElement>(
    '[aria-label="Resource group selection"]'
  )!
  userEvent.click(alphaSelection.querySelector("input")!)
  expect(alphaSelection).toHaveAttribute("aria-checked", "true")

  const tiltfileSummary = container.querySelector<HTMLElement>(
    'tr[data-group-id="tiltfile"] .overviewGroupSummary'
  )!
  userEvent.click(tiltfileSummary)
  expect(tiltfileSummary).toHaveAttribute("aria-expanded", "false")
  fireEvent.keyDown(tiltfileSummary, { key: "Enter" })
  expect(tiltfileSummary).toHaveAttribute("aria-expanded", "true")
})

it("calibrates selectable and text-only expanded group headers independently", () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (
      this.tagName === "TBODY" &&
      this.classList.contains("overviewGroupHeaderBody") &&
      this.classList.contains("isExpanded")
    )
      return {
        height: this.querySelector('[aria-label="Resource group selection"]')
          ? 96
          : 90,
        top: 0,
      } as DOMRect
    return { height: 20, top: 0 } as DOMRect
  }

  const view = nResourceView(3)
  view.uiResources[1].metadata!.labels = { alpha: "alpha" }
  try {
    const { container } = render(tableViewWithSettings({ view }))
    const headers = container.querySelectorAll<HTMLElement>(
      "tbody[data-overview-group-header].isExpanded"
    )
    expect(headers).toHaveLength(3)
    expect(
      headers[0].querySelector('[aria-label="Resource group selection"]')
    ).not.toBeNull()
    expect(
      headers[2].querySelector('[aria-label="Resource group selection"]')
    ).toBeNull()
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
  }
})

it("fails closed through the overview window when its owner has zero height", () => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 0,
  })
  try {
    expect(() =>
      render(tableViewWithSettings({ view: nResourceWithLabelsView(1) }))
    ).toThrow("Resource virtual window requires a positive owner height")
  } finally {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 1000,
    })
  }
})

it("keeps the overview bounded without ResizeObserver", () => {
  const resizeObserver = Object.getOwnPropertyDescriptor(
    window,
    "ResizeObserver"
  )
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: undefined,
  })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 20,
  })
  try {
    const { container } = render(
      tableViewWithSettings({ view: nResourceWithLabelsView(100) })
    )
    expect(
      container.querySelectorAll("tr[data-occurrence-key]").length
    ).toBeLessThanOrEqual(3)
  } finally {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 1000,
    })
    if (resizeObserver)
      Object.defineProperty(window, "ResizeObserver", resizeObserver)
    else Reflect.deleteProperty(window, "ResizeObserver")
  }
})

it("keeps interactive selection focus and selected row styling with no row target", () => {
  const { container } = render(
    tableViewWithSettings({
      view: nResourceView(1),
      resourceSelections: ["(Tiltfile)"],
    })
  )
  const star = screen.getAllByTitle("Star this Resource")[0]

  userEvent.click(star)

  expect(document.activeElement).toBe(star)
  expect(container.querySelector("tr[data-occurrence-key]")).toHaveClass(
    "isSelected"
  )
  expect(container.querySelector("tr.isFocused")).toBeNull()
})

it("fails closed when overview projection invariants are missing", () => {
  expect(() => requireOverviewResource(new Map(), "api")).toThrow(
    "missing resource api"
  )
  expect(() => requireOverviewResource(new Map(), "")).toThrow(
    "non-empty resource name"
  )
  expect(() => requireOverviewEntryIndex(new Map(), "label:api")).toThrow(
    "missing logical entry index"
  )
})

it("shows buttons on the appropriate resources", () => {
  let view = nResourceView(3)
  // one resource with one button, one with multiple, and one with none
  view.uiButtons = [
    oneUIButton({
      buttonName: "button1",
      buttonText: "text1",
      componentID: view.uiResources[0].metadata?.name!,
    }),
    oneUIButton({
      buttonName: "button2",
      buttonText: "text2",
      componentID: view.uiResources[1].metadata?.name!,
    }),
    oneUIButton({
      buttonName: "button3",
      buttonText: "text3",
      componentID: view.uiResources[1].metadata?.name!,
    }),
  ]

  const { container } = render(tableViewWithSettings({ view }))

  // buttons expected to be on each row, in order
  const expectedButtons = [["text1"], ["text2", "text3"], []]
  // first row is headers, so skip it
  const rows = Array.from(container.querySelectorAll(ResourceTableRow)).slice(1)
  const actualButtons = rows.map((row) =>
    Array.from(row.querySelectorAll(ApiButtonRoot)).map((e) =>
      e.getAttribute("aria-label")
    )
  )

  expect(actualButtons).toEqual(expectedButtons)
})

it("sorts by status", () => {
  let view = nResourceView(10)
  view.uiResources[3].status!.updateStatus = UpdateStatus.Error
  view.uiResources[7].status!.runtimeStatus = RuntimeStatus.Error
  view.uiResources.unshift(
    oneResource({ disabled: true, name: "disabled_resource" })
  )

  const { container } = render(
    tableViewWithSettings({
      view,
      resourceListOptions: { ...DEFAULT_OPTIONS, showDisabledResources: true },
    })
  )

  const statusHeader = screen.getByText("Status")
  userEvent.click(statusHeader)

  const rows = Array.from(container.querySelectorAll(ResourceTableRow)).slice(1) // skip the header
  const actualResources = rows.map(
    (row) =>
      row.querySelectorAll(ResourceTableData)[4].querySelector("button")!
        .textContent
  )
  // 3 and 7 go first because they're failing, then it's alpha,
  // followed by disabled resources
  const expectedResources = [
    "_3",
    "_7",
    "(Tiltfile)",
    "_1",
    "_2",
    "_4",
    "_5",
    "_6",
    "_8",
    "_9",
    "disabled_resource",
  ]
  expect(expectedResources).toEqual(actualResources)
})

describe("resource name filter", () => {
  describe("when a filter is applied", () => {
    let view: TestDataView
    let container: HTMLElement

    beforeEach(() => {
      view = nResourceView(100)
      container = renderContainer(
        tableViewWithSettings({
          view,
          resourceListOptions: {
            ...DEFAULT_OPTIONS,
            resourceNameFilter: "1",
          },
        })
      )
    })

    it("displays an accurate result count", () => {
      const resultCount = container.querySelector(ResourceResultCount)
      expect(resultCount).toBeDefined()
      // Expect 19 results because test data names resources with their index number
      expect(resultCount!.textContent).toMatch(/19/)
    })

    it("displays only matching resources if there are matches", () => {
      const matchingRows = container.querySelectorAll("table tr")

      // Expect 20 results because test data names resources with their index number
      expect(matchingRows.length).toBeGreaterThan(1)

      const displayedResourceNames = Array.from(
        container.querySelectorAll(Name)
      ).map((nameCell: any) => nameCell.textContent)
      const everyNameMatchesFilterTerm = displayedResourceNames.every((name) =>
        matchesResourceName(name, "1")
      )

      expect(everyNameMatchesFilterTerm).toBe(true)
    })

    it("displays a `no matches` message if there are no matches", () => {
      container = renderContainer(
        tableViewWithSettings({
          view,
          resourceListOptions: {
            ...DEFAULT_OPTIONS,
            resourceNameFilter: "eek no matches!",
          },
        })
      )

      expect(container.querySelector(NoMatchesFound)).toBeDefined()
    })
  })

  describe("when a filter is NOT applied", () => {
    it("displays all resources", () => {
      const { container } = render(
        tableViewWithSettings({
          view: nResourceView(10),
          resourceListOptions: { ...DEFAULT_OPTIONS },
        })
      )

      expect(
        container.querySelectorAll(`tbody ${ResourceTableRow}`).length
      ).toBe(10)
    })
  })
})

describe("when labels feature is enabled", () => {
  it("it displays tables grouped by labels if resources have labels", () => {
    const { container } = render(
      tableViewWithSettings({
        view: nResourceWithLabelsView(5),
        labelsEnabled: true,
      })
    )

    let labels = Array.from(
      container.querySelectorAll("tr[data-group-id] .overviewGroupName")
    ).map((n) => n.textContent)
    expect(labels).toEqual([
      "backend",
      "frontend",
      "javascript",
      "test",
      "very_long_long_long_label",
      "unlabeled",
      "Tiltfile",
    ])
  })

  it("it displays a single table if no resources have labels", () => {
    const { container } = render(
      tableViewWithSettings({ view: nResourceView(5), labelsEnabled: true })
    )

    let labels = Array.from(
      container.querySelectorAll("tr[data-group-id] .overviewGroupName")
    ).map((n) => n.textContent)
    expect(labels).toEqual([])
  })

  it("it displays the resource grouping tooltip if no resources have labels", () => {
    const { container } = render(
      tableViewWithSettings({ view: nResourceView(5), labelsEnabled: true })
    )

    expect(
      container.querySelectorAll('#table-groups-info[role="tooltip"]').length
    ).toBe(1)
  })
})

describe("when labels feature is NOT enabled", () => {
  let container: HTMLElement

  beforeEach(() => {
    container = renderContainer(
      tableViewWithSettings({
        view: nResourceWithLabelsView(5),
        labelsEnabled: false,
      })
    )
  })

  it("it displays a single table", () => {
    expect(container.querySelectorAll("table").length).toBe(1)
  })

  it("it does not display the resource grouping tooltip", () => {
    expect(container.querySelectorAll(".MuiTooltip").length).toBe(0)
  })
})

describe("overview table without groups", () => {
  let view: TestDataView
  let container: HTMLElement

  beforeEach(() => {
    view = nResourceView(8)
    container = renderContainer(
      tableViewWithSettings({ view, labelsEnabled: true })
    )
  })

  describe("sorting", () => {
    it("table column header displays ascending arrow when sorted ascending", () => {
      userEvent.click(findTableHeaderByName("Pod ID"))
      const arrowIcon = findTableHeaderByName("Pod ID").querySelector(
        ResourceTableHeaderSortTriangle
      )

      expect(arrowIcon.classList.contains("is-sorted-asc")).toBe(true)
    })

    it("table column header displays descending arrow when sorted descending", () => {
      userEvent.click(findTableHeaderByName("Pod ID"))
      userEvent.click(findTableHeaderByName("Pod ID"))
      const arrowIcon = findTableHeaderByName("Pod ID").querySelector(
        ResourceTableHeaderSortTriangle
      )

      expect(arrowIcon.classList.contains("is-sorted-desc")).toBe(true)
    })
  })
})

describe("overview table with groups", () => {
  let view: TestDataView
  let container: HTMLElement
  let resources: GroupByLabelView<RowValues>

  beforeEach(() => {
    view = nResourceWithLabelsView(8)
    container = renderContainer(
      tableViewWithSettings({ view, labelsEnabled: true })
    )
    resources = labeledResourcesToTableCells(
      view.uiResources,
      view.uiButtons,
      new LogStore()
    )

    sessionStorage.clear()
    localStorage.clear()
  })

  afterEach(() => {
    sessionStorage.clear()
    localStorage.clear()
  })

  describe("display", () => {
    it("does not show the resource groups tooltip", () => {
      expect(container.querySelectorAll(".MuiTooltip").length).toBe(0)
    })

    it("renders each label group in order", () => {
      const { labels: sortedLabels } = resources
      const groupNames = container.querySelectorAll(
        "tr[data-group-id] .overviewGroupName"
      )

      // Loop through the sorted labels (which includes every label
      // attached to a resource, but not unlabeled or tiltfile "labels")
      sortedLabels.forEach((label, idx) => {
        const groupName = groupNames[idx]
        expect(groupName.textContent).toBe(label)
      })
    })

    // Note: the sample data generated in the test helper `nResourcesWithLabels`
    // always includes unlabeled resources
    it("renders a resource group for unlabeled resources and for Tiltfiles", () => {
      const groupNames = Array.from(
        container.querySelectorAll("tr[data-group-id] .overviewGroupName")
      )
      expect(screen.getAllByText(UNLABELED_LABEL)).toBeTruthy()
      expect(screen.getAllByText(TILTFILE_LABEL)).toBeTruthy()
    })

    it("renders one semantic table for every resource group", () => {
      expect(container.querySelectorAll("table")).toHaveLength(1)
      const groupIds = Array.from(
        container.querySelectorAll("tr[data-group-id]")
      ).map((row) => row.getAttribute("data-group-id"))
      expect(groupIds).toEqual([
        ...resources.labels.map((label) => `label:${label}`),
        "ungrouped",
        "tiltfile",
      ])
    })

    it("renders the correct resources in each label group", () => {
      const { labelsToResources, unlabeled, tiltfile } = resources
      const expectedResourcesFromLabelGroups: { [key: string]: string[] } = {}

      // Create a dictionary of labels to a list of resource names
      // based on the view
      Object.keys(labelsToResources).forEach((label) => {
        const resourceNames = labelsToResources[label].map((r) => r.name)
        expectedResourcesFromLabelGroups[label] = resourceNames
      })

      expectedResourcesFromLabelGroups[UNLABELED_LABEL] = unlabeled.map(
        (r) => r.name
      )
      expectedResourcesFromLabelGroups[TILTFILE_LABEL] = tiltfile.map(
        (r) => r.name
      )

      const renderedNames = Array.from(container.querySelectorAll(Name)).map(
        (resourceName: any) => resourceName.textContent
      )
      expect(renderedNames.sort()).toEqual(
        Object.values(expectedResourcesFromLabelGroups).flat().sort()
      )
    })
  })

  describe("resource status summary", () => {
    it("renders summaries for each label group", () => {
      const summaries = container.querySelectorAll(ResourceStatusSummaryRoot)
      const totalLabelCount =
        resources.labels.length +
        (resources.tiltfile.length ? 1 : 0) +
        (resources.unlabeled.length ? 1 : 0)

      expect(summaries.length).toBe(totalLabelCount)
    })
  })

  describe("expand and collapse", () => {
    let groups: NodeListOf<Element>

    // Helpers
    const getResourceGroups = () =>
      container.querySelectorAll("tr[data-group-id]")

    beforeEach(() => {
      groups = getResourceGroups()
    })

    it("displays as expanded or collapsed based on the ResourceGroupContext", () => {
      // Create an existing randomized group state from the labels
      const { labels } = resources
      const testData: GroupsState = [
        ...labels,
        UNLABELED_LABEL,
        TILTFILE_LABEL,
      ].reduce((groupsState: GroupsState, label) => {
        const randomLabelState = Math.random() > 0.5
        groupsState[label] = {
          ...DEFAULT_GROUP_STATE,
          expanded: randomLabelState,
        }

        return groupsState
      }, {})
      container = renderContainer(
        tableViewWithSettings({
          view,
          labelsEnabled: true,
          groupsState: testData,
        })
      )

      Array.from(
        container.querySelectorAll<HTMLElement>(
          "tr[data-group-id] [role='button'][aria-expanded]"
        )
      ).forEach((button) => {
        const groupId = button.closest("tr")!.getAttribute("data-group-id")!
        const label =
          groupId === "ungrouped"
            ? UNLABELED_LABEL
            : groupId === "tiltfile"
            ? TILTFILE_LABEL
            : groupId.slice("label:".length)
        expect(button.getAttribute("aria-expanded")).toBe(
          String(testData[label]?.expanded ?? true)
        )
      })
    })

    it("is collapsed when an expanded resource group summary is clicked on", () => {
      const group = groups[0]
      expect(
        group.querySelector("[role='button']")!.getAttribute("aria-expanded")
      ).toBe("true")

      userEvent.click(group.querySelector("[role='button']") as Element)

      // Manually refresh the test component tree
      groups = getResourceGroups()

      const updatedGroup = groups[0]
      expect(
        updatedGroup
          .querySelector("[role='button']")!
          .getAttribute("aria-expanded")
      ).toBe("false")
    })

    it("is expanded when a collapsed resource group summary is clicked on", () => {
      // Because groups are expanded by default, click on it once to get it
      // into a collapsed state for testing
      const initialGroup = groups[0]
      expect(
        initialGroup
          .querySelector("[role='button']")!
          .getAttribute("aria-expanded")
      ).toBe("true")

      userEvent.click(initialGroup.querySelector("[role='button']") as Element)

      const group = getResourceGroups()[0]
      expect(
        group.querySelector("[role='button']")!.getAttribute("aria-expanded")
      ).toBe("false")

      userEvent.click(group.querySelector("[role='button']")!)

      const updatedGroup = getResourceGroups()[0]
      expect(
        updatedGroup
          .querySelector("[role='button']")!
          .getAttribute("aria-expanded")
      ).toBe("true")
    })
  })

  describe("sorting", () => {
    let firstTableNameColumn: any
    const namesForGroup = (groupId: string) => {
      const rows = Array.from(container.querySelectorAll("tbody tr"))
      const start = rows.findIndex(
        (row) => row.getAttribute("data-group-id") === groupId
      )
      const following = rows.slice(start + 1)
      const nextGroup = following.findIndex((row) =>
        row.hasAttribute("data-group-id")
      )
      return following
        .slice(0, nextGroup < 0 ? undefined : nextGroup)
        .map((row) => row.querySelector(Name)?.textContent)
        .filter((name): name is string => !!name)
    }

    beforeEach(() => {
      // Find and click the "Resource Name" column on the first table group
      firstTableNameColumn = screen.getAllByTitle("Sort by Resource Name")[0]
      userEvent.click(firstTableNameColumn)
    })

    it("tables sort by ascending values when clicked once", () => {
      expect(namesForGroup("label:test")).toStrictEqual([
        "_1",
        "_3",
        "_5",
        "_7",
        "a_failed_build",
      ])
    })

    it("tables sort by descending values when clicked twice", () => {
      userEvent.click(firstTableNameColumn)

      expect(namesForGroup("label:test")).toStrictEqual([
        "a_failed_build",
        "_7",
        "_5",
        "_3",
        "_1",
      ])
    })

    it("tables un-sort when clicked thrice", () => {
      userEvent.click(firstTableNameColumn)
      userEvent.click(firstTableNameColumn)

      expect(namesForGroup("label:test")).toStrictEqual([
        "_1",
        "_3",
        "_5",
        "_7",
        "a_failed_build",
      ])
    })
  })

  describe("resource name filter", () => {
    it("does not display tables in groups when a resource filter is applied", () => {
      const nameFilterContainer = renderContainer(
        tableViewWithSettings({
          view,
          labelsEnabled: true,
          resourceListOptions: {
            resourceNameFilter: "filtering!",
            alertsOnTop: false,
            showDisabledResources: true,
          },
        })
      )

      expect(
        nameFilterContainer.querySelectorAll("tr[data-group-id]").length
      ).toBe(0)
    })
  })
})

describe("when disable resources feature is enabled and `showDisabledResources` option is true", () => {
  let view: TestDataView
  let container: HTMLElement

  beforeEach(() => {
    view = nResourceView(4)
    // Add two disabled resources to view and place them throughout list
    const firstDisabledResource = oneResource({
      name: "zee_disabled_resource",
      disabled: true,
    })
    const secondDisabledResource = oneResource({
      name: "_0_disabled_resource",
      disabled: true,
    })
    view.uiResources.unshift(firstDisabledResource)
    view.uiResources.push(secondDisabledResource)
    // Add a button to the first disabled resource
    view.uiButtons = [
      oneUIButton({ componentID: firstDisabledResource.metadata!.name }),
    ]
    container = renderContainer(
      tableViewWithSettings({
        view,
        resourceListOptions: {
          ...DEFAULT_OPTIONS,
          showDisabledResources: true,
        },
      })
    )
  })

  it("displays disabled resources at the bottom of the table", () => {
    const visibleResources = Array.from(container.querySelectorAll(Name))
    const resourceNamesInOrder = visibleResources.map((r: any) => r.textContent)
    expect(resourceNamesInOrder.length).toBe(6)

    const expectedNameOrder = [
      "(Tiltfile)",
      "_1",
      "_2",
      "_3",
      "zee_disabled_resource",
      "_0_disabled_resource",
    ]

    expect(resourceNamesInOrder).toStrictEqual(expectedNameOrder)
  })

  it("sorts disabled resources along with enabled resources", () => {
    // Click twice to sort by resource name descending (Z -> A)
    let header = findTableHeaderByName("Resource Name", true)
    userEvent.click(header)
    userEvent.click(header)

    const resourceNamesInOrder = Array.from(
      container.querySelectorAll(Name)
    ).map((r: any) => r.textContent)

    const expectedNameOrder = [
      "zee_disabled_resource",
      "_3",
      "_2",
      "_1",
      "_0_disabled_resource",
      "(Tiltfile)",
    ]

    expect(resourceNamesInOrder).toStrictEqual(expectedNameOrder)
  })

  it("does NOT display controls for a disabled resource", () => {
    // Get the last resource table row, which should be a disabled resource
    const disabledResource = container.querySelectorAll(ResourceTableRow)[5]
    const resourceName = disabledResource.querySelector(Name)

    let buttons = Array.from(disabledResource.querySelectorAll("button"))
      // Remove disabled buttons
      .filter((button: any) => !button.classList.contains("is-disabled"))
      .filter((button: any) => !button.classList.contains("isDisabled"))
      // Remove the star button
      .filter((button: any) => button.title != "Star this Resource")
    expect(resourceName!.textContent).toBe("zee_disabled_resource")
    expect(buttons).toHaveLength(0)
  })

  it("adds `isDisabled` class to table rows for disabled resources", () => {
    // Expect two disabled resources based on hardcoded test data
    const disabledRows = container.querySelectorAll(
      ResourceTableRow + ".isDisabled"
    )
    expect(disabledRows.length).toBe(2)
  })
})

describe("`showDisabledResources` option is false", () => {
  it("does NOT display disabled resources", () => {
    const view = nResourceView(8)
    // Add a disabled resource to view
    const disabledResource = oneResource({
      name: "disabled_resource",
      disabled: true,
    })
    view.uiResources.push(disabledResource)

    const { container } = render(
      tableViewWithSettings({
        view,
        resourceListOptions: {
          ...DEFAULT_OPTIONS,
          showDisabledResources: false,
        },
      })
    )

    const visibleResources = Array.from(container.querySelectorAll(Name))
    const resourceNames = visibleResources.map((r) => r.textContent)
    expect(resourceNames.length).toBe(8)
    expect(resourceNames).not.toContain("disabled_resource")
  })
})

describe("bulk disable actions", () => {
  function allEnabledCheckboxes(el: HTMLElement) {
    return Array.from(
      el.querySelectorAll(`${SelectionCheckbox}:not(.Mui-disabled)`)
    )
  }

  describe("when disable resources feature is enabled", () => {
    let view: TestDataView
    let container: HTMLElement

    beforeEach(() => {
      view = nResourceView(4)
      container = renderContainer(tableViewWithSettings({ view }))
    })

    it("renders labels on enabled checkbox", () => {
      let els = container.querySelectorAll(
        `${SelectionCheckbox}:not(.Mui-disabled)`
      )
      expect(els[0].getAttribute("aria-label")).toBe("Resource group selection")
      expect(els[1].getAttribute("aria-label")).toBe("Select resource")
    })

    it("renders labels on disabled checkbox", () => {
      let el = container.querySelector(`${SelectionCheckbox}.Mui-disabled`)
      expect(el!.getAttribute("aria-label")).toBe("Cannot select resource")
    })

    it("renders the `Select` column", () => {
      expect(
        container.querySelectorAll(SelectionCheckbox).length
      ).toBeGreaterThan(0)
    })

    it("renders a checkbox for the column header and every resource that is selectable", () => {
      const expectedCheckBoxDisplay = {
        "(Tiltfile)": false,
        columnHeader: true,
        _1: true,
        _2: true,
        _3: true,
      }
      const actualCheckboxDisplay: { [key: string]: boolean } = {}
      const rows = Array.from(container.querySelectorAll(ResourceTableRow))
      rows.forEach((row: any, idx: number) => {
        let name: string
        if (idx === 0) {
          name = "columnHeader"
        } else {
          name = row.querySelector(Name).textContent
        }

        const checkbox = allEnabledCheckboxes(row)
        actualCheckboxDisplay[name] = checkbox.length === 1
      })

      expect(actualCheckboxDisplay).toEqual(expectedCheckBoxDisplay)
    })

    it("selects a resource when checkbox is not checked", () => {
      const checkbox = allEnabledCheckboxes(container)[1]
      userEvent.click(checkbox.querySelector("input")!)

      const checkboxAfterClick = allEnabledCheckboxes(container)[1]
      expect(checkboxAfterClick.getAttribute("aria-checked")).toBe("true")
    })

    it("deselects a resource when checkbox is checked", () => {
      const checkbox = allEnabledCheckboxes(container)[1]
      expect(checkbox).toBeTruthy()

      // Click the checkbox once to get it to a selected state
      userEvent.click(checkbox.querySelector("input")!)

      const checkboxAfterFirstClick = allEnabledCheckboxes(container)[1]
      expect(checkboxAfterFirstClick.getAttribute("aria-checked")).toBe("true")

      // Click the checkbox a second time to deselect it
      userEvent.click(checkbox.querySelector("input")!)

      const checkboxAfterSecondClick = allEnabledCheckboxes(container)[1]
      expect(checkboxAfterSecondClick.getAttribute("aria-checked")).toBe(
        "false"
      )
    })

    describe("selection checkbox header", () => {
      it("displays as unchecked if no resources in the table are checked", () => {
        const allCheckboxes = allEnabledCheckboxes(container)
        let checkbox: any = allCheckboxes[0]
        const headerCheckboxCheckedState = checkbox.getAttribute("aria-checked")
        const headerCheckboxIndeterminateState = checkbox
          .querySelector("[data-indeterminate]")
          .getAttribute("data-indeterminate")
        const rowCheckboxesState = allCheckboxes
          .slice(1)
          .map((checkbox: any) => checkbox.getAttribute("aria-checked"))

        expect(rowCheckboxesState).toStrictEqual(["false", "false", "false"])
        expect(headerCheckboxCheckedState).toBe("false")
        expect(headerCheckboxIndeterminateState).toBe("false")
      })

      it("displays as indeterminate if some but not all resources in the table are checked", () => {
        // Choose a (random) table row to click and select
        const resourceCheckbox: any = allEnabledCheckboxes(container)[2]
        userEvent.click(resourceCheckbox.querySelector("input"))

        // Verify that the header checkbox displays as partially selected
        const headerCheckboxCheckedState = container
          .querySelector(SelectionCheckbox)!
          .getAttribute("aria-checked")
        const headerCheckboxIndeterminateState = container
          .querySelector(`${SelectionCheckbox} [data-indeterminate]`)!
          .getAttribute("data-indeterminate")

        expect(headerCheckboxCheckedState).toBe("false")
        expect(headerCheckboxIndeterminateState).toBe("true")
      })

      it("displays as checked if all resources in the table are checked", () => {
        // Click all checkboxes for resource rows, skipping the first one (which is the table header row)
        allEnabledCheckboxes(container)
          .slice(1)
          .forEach((resourceCheckbox: any) => {
            userEvent.click(resourceCheckbox.querySelector("input"))
          })

        // Verify that the header checkbox displays as partially selected
        const headerCheckboxCheckedState = container
          .querySelector(SelectionCheckbox)!
          .getAttribute("aria-checked")
        const headerCheckboxIndeterminateState = container
          .querySelector(`${SelectionCheckbox} [data-indeterminate]`)!
          .getAttribute("data-indeterminate")

        expect(headerCheckboxCheckedState).toBe("true")
        expect(headerCheckboxIndeterminateState).toBe("false")
      })

      it("selects every resource in the table when checkbox is not checked", () => {
        // Click the header checkbox to select it
        const headerCheckbox = allEnabledCheckboxes(container)[0]
        userEvent.click(headerCheckbox.querySelector("input")!)

        // Verify all table resources are now selected
        const rowCheckboxesState = allEnabledCheckboxes(container)
          .slice(1)
          .map((checkbox: any) => checkbox.getAttribute("aria-checked"))
        expect(rowCheckboxesState).toStrictEqual(["true", "true", "true"])
      })

      it("deselects every resource in the table when checkbox is checked", () => {
        const headerCheckbox = container.querySelector(SelectionCheckbox)!
        userEvent.click(headerCheckbox.querySelector("input")!)

        // Click the checkbox a second time to deselect it
        const headerCheckboxAfterFirstClick =
          container.querySelector(SelectionCheckbox)!
        userEvent.click(headerCheckboxAfterFirstClick.querySelector("input")!)

        // Verify all table resources are now deselected
        const rowCheckboxesState = allEnabledCheckboxes(container)
          .slice(1)
          .map((checkbox: any) => checkbox.getAttribute("aria-checked"))
        expect(rowCheckboxesState).toStrictEqual(["false", "false", "false"])
      })
    })
  })
})

// https://github.com/tilt-dev/tilt/issues/5754
it("renders the trigger mode column correctly", () => {
  const view = nResourceView(2)
  view.uiResources = [
    oneResource({ name: "r1", triggerMode: TriggerMode.TriggerModeAuto }),
    oneResource({ name: "r2", triggerMode: TriggerMode.TriggerModeManual }),
  ]
  const container = renderContainer(tableViewWithSettings({ view: view }))

  const isToggleContent = (content: string) =>
    content == ToggleTriggerModeTooltip.isAuto ||
    content == ToggleTriggerModeTooltip.isManual

  let modes = Array.from(screen.getAllByTitle(isToggleContent)).map(
    (n) => n.title
  )
  expect(modes).toEqual([
    ToggleTriggerModeTooltip.isAuto,
    ToggleTriggerModeTooltip.isManual,
  ])
})

function renderContainer(x: ReactElement) {
  let { container } = render(x)
  return container
}
