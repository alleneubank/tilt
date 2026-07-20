import {
  fireEvent,
  render,
  RenderOptions,
  RenderResult,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import React from "react"
import { MemoryRouter } from "react-router"
import { accessorsForTesting, tiltfileKeyContext } from "./BrowserStorage"
import Features, { FeaturesTestProvider, Flag } from "./feature"
import LogStore from "./LogStore"
import PathBuilder from "./PathBuilder"
import { ResourceNavContextProvider } from "./ResourceNav"
import { ResourceGroupsContextProvider } from "./ResourceGroupsContext"
import {
  DEFAULT_OPTIONS,
  ResourceListOptions,
  ResourceListOptionsProvider,
  RESOURCE_LIST_OPTIONS_KEY,
} from "./ResourceListOptionsContext"
import SidebarItem from "./SidebarItem"
import SidebarResources from "./SidebarResources"
import { StarredResourcesContextProvider } from "./StarredResourcesContext"
import { nResourceView, nResourceWithLabelsView, oneResource } from "./testdata"
import { ResourceName, ResourceStatus, ResourceView } from "./types"

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeAll(() => {
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 24,
  })
  jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 24,
    height: 24,
  } as DOMRect)
})

let pathBuilder = PathBuilder.forTesting("localhost", "/")

const resourceListOptionsAccessor = accessorsForTesting<ResourceListOptions>(
  RESOURCE_LIST_OPTIONS_KEY,
  sessionStorage
)
const starredItemsAccessor = accessorsForTesting<string[]>(
  "pinned-resources",
  localStorage
)

function createSidebarItems(n: number, withLabels = false) {
  const logStore = new LogStore()
  const resourceView = withLabels ? nResourceWithLabelsView : nResourceView
  const resources = resourceView(n).uiResources
  return resources.map((r) => new SidebarItem(r, logStore))
}

function createSidebarItemsWithAlerts() {
  const logStore = new LogStore()
  return [
    oneResource({ isBuilding: true }),
    oneResource({ name: "a" }),
    oneResource({ name: "b" }),
    oneResource({ name: "c", disabled: true }),
  ].map((res) => new SidebarItem(res, logStore))
}

function customRender(
  componentOptions: {
    items: SidebarItem[]
    selected?: string
    resourceListOptions?: ResourceListOptions
    routeAware?: boolean
    groupState?: Record<string, { expanded: boolean }>
  },
  renderOptions?: RenderOptions
) {
  const features = new Features({
    [Flag.Labels]: true,
  })
  const listOptions = componentOptions.resourceListOptions ?? DEFAULT_OPTIONS
  const sidebar = componentOptions.routeAware ? (
    <RouteAwareSidebar
      {...componentOptions}
      resourceListOptions={listOptions}
    />
  ) : (
    <SidebarResources
      items={componentOptions.items}
      selected={componentOptions.selected ?? ""}
      resourceView={ResourceView.Log}
      pathBuilder={pathBuilder}
      resourceListOptions={listOptions}
    />
  )
  return render(sidebar, {
    wrapper: ({ children }) => (
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <tiltfileKeyContext.Provider value="test">
          <FeaturesTestProvider value={features}>
            <StarredResourcesContextProvider>
              <ResourceGroupsContextProvider
                initialValuesForTesting={componentOptions.groupState}
              >
                <ResourceListOptionsProvider>
                  {children}
                </ResourceListOptionsProvider>
              </ResourceGroupsContextProvider>
            </StarredResourcesContextProvider>
          </FeaturesTestProvider>
        </tiltfileKeyContext.Provider>
      </MemoryRouter>
    ),
    ...renderOptions,
  })
}

function RouteAwareSidebar(
  props: Parameters<typeof customRender>[0] & {
    resourceListOptions: ResourceListOptions
  }
) {
  const [selected, setSelected] = React.useState(props.selected ?? "")
  return (
    <ResourceNavContextProvider
      value={{
        selectedResource: selected,
        invalidResource: "",
        openResource: setSelected,
      }}
    >
      <SidebarResources
        items={props.items}
        selected={selected}
        resourceView={ResourceView.Log}
        pathBuilder={pathBuilder}
        resourceListOptions={props.resourceListOptions}
      />
    </ResourceNavContextProvider>
  )
}

describe("SidebarResources", () => {
  let originalClientHeight: PropertyDescriptor | undefined
  let originalRect: typeof HTMLElement.prototype.getBoundingClientRect

  beforeAll(() => {
    // jsdom has no layout engine. Supply standards-shaped geometry so the
    // production virtual window takes its measured path in this integration suite.
    originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight"
    )
    originalRect = HTMLElement.prototype.getBoundingClientRect
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 1000,
    })
    HTMLElement.prototype.getBoundingClientRect = function () {
      const owner = this.closest<HTMLElement>('[aria-label="Resource logs"]')
      const scrollTop = owner?.scrollTop ?? 0
      return {
        // Browser geometry moves descendants with their scroll owner. Keeping
        // the owner-relative origin stable is essential now that the window
        // intentionally compares its actual measured content origin.
        top: this === owner ? 0 : -scrollTop,
        bottom: this === owner ? 20 : 20 - scrollTop,
        height: 20,
      } as DOMRect
    }
  })

  afterAll(() => {
    if (originalClientHeight) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientHeight",
        originalClientHeight
      )
    }
    HTMLElement.prototype.getBoundingClientRect = originalRect
  })

  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
  })

  afterEach(() => {
    sessionStorage.clear()
    localStorage.clear()
  })

  describe("starring resources", () => {
    const items = createSidebarItems(2)

    it("adds items to the starred list when items are starred", async () => {
      const itemToStar = items[1].name
      customRender({ items: items })

      userEvent.click(
        screen.getByRole("button", { name: `Star ${itemToStar}` })
      )

      await waitFor(() => {
        expect(starredItemsAccessor.get()).toEqual([itemToStar])
      })
    })

    it("removes items from the starred list when items are unstarred", async () => {
      starredItemsAccessor.set(items.map((i) => i.name))
      customRender({ items })

      userEvent.click(
        screen.getByRole("button", { name: `Unstar ${items[1].name}` })
      )

      await waitFor(() => {
        expect(starredItemsAccessor.get()).toEqual([items[0].name])
      })
    })
  })

  describe("resource list options", () => {
    const items = createSidebarItemsWithAlerts()

    const loadCases: [string, ResourceListOptions, string[]][] = [
      [
        "alertsOnTop",
        { ...DEFAULT_OPTIONS, alertsOnTop: true },
        ["vigoda", "a", "b"],
      ],
      [
        "resourceNameFilter",
        { ...DEFAULT_OPTIONS, resourceNameFilter: "vig" },
        ["vigoda"],
      ],
      [
        "showDisabledResources",
        { ...DEFAULT_OPTIONS, showDisabledResources: true },
        ["vigoda", "a", "b", "c"],
      ],
    ]
    test.each(loadCases)(
      "loads %p from browser storage",
      (_name, resourceListOptions, expectedItems) => {
        resourceListOptionsAccessor.set(resourceListOptions)

        customRender({ items, resourceListOptions })

        // Find the sidebar items for the expected list
        expectedItems.forEach((item) => {
          expect(screen.getByText(item, { exact: true })).toBeInTheDocument()
        })

        // Check that each option reflects the storage value
        const aotToggle = screen.getByLabelText("Alerts on top")
        expect((aotToggle as HTMLInputElement).checked).toBe(
          resourceListOptions.alertsOnTop
        )

        const resourceNameFilter = screen.getByPlaceholderText(
          "Filter resources by name"
        )
        expect(resourceNameFilter).toHaveValue(
          resourceListOptions.resourceNameFilter
        )

        const disabledToggle = screen.getByLabelText("Show disabled resources")
        expect(disabledToggle).toBeTruthy()
        expect((disabledToggle as HTMLInputElement).checked).toBe(
          resourceListOptions.showDisabledResources
        )
      }
    )

    const saveCases: [string, ResourceListOptions][] = [
      ["alertsOnTop", { ...DEFAULT_OPTIONS, alertsOnTop: true }],
      ["resourceNameFilter", { ...DEFAULT_OPTIONS, resourceNameFilter: "foo" }],
      [
        "showDisabledResources",
        { ...DEFAULT_OPTIONS, showDisabledResources: true },
      ],
    ]
    test.each(saveCases)(
      "saves option %s to browser storage",
      (_name, expectedOptions) => {
        customRender({ items })

        const aotToggle = screen.getByLabelText("Alerts on top")
        if (
          (aotToggle as HTMLInputElement).checked !==
          expectedOptions.alertsOnTop
        ) {
          userEvent.click(aotToggle)
        }

        const resourceNameFilter = screen.getByPlaceholderText(
          "Filter resources by name"
        )
        if (expectedOptions.resourceNameFilter) {
          userEvent.type(resourceNameFilter, expectedOptions.resourceNameFilter)
        }

        const disabledToggle = screen.getByLabelText("Show disabled resources")
        if (
          (disabledToggle as HTMLInputElement).checked !==
          expectedOptions.showDisabledResources
        ) {
          userEvent.click(disabledToggle)
        }

        const observedOptions = resourceListOptionsAccessor.get()
        expect(observedOptions).toEqual(expectedOptions)
      }
    )
  })

  it("uses the list origin, rather than sidebar chrome, for bounded owner scrolling", async () => {
    const items = createSidebarItems(50)
    items.forEach((item) => (item.labels = ["team"]))
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    let owner: HTMLElement | null = null
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.getAttribute("aria-label") === "Resource logs") {
        owner = this
        return { top: 100, bottom: 140, height: 40 } as DOMRect
      }
      if (this.tagName === "UL")
        return {
          top: 130 - (owner?.scrollTop ?? 0),
          bottom: 130 - (owner?.scrollTop ?? 0),
          height: 0,
        } as DOMRect
      if (this.parentElement === owner)
        return {
          top: 100 - (owner?.scrollTop ?? 0),
          bottom: 100 - (owner?.scrollTop ?? 0),
          height: 0,
        } as DOMRect
      return { height: 10 } as DOMRect
    }
    const view = customRender({ items })
    const sidebarOwner = screen.getByLabelText("Resource logs") as HTMLElement
    owner = sidebarOwner
    Object.defineProperty(sidebarOwner, "clientHeight", {
      configurable: true,
      value: 40,
    })

    sidebarOwner.scrollTop = 100
    fireEvent.scroll(sidebarOwner)
    await waitFor(() =>
      expect(screen.getByText(items[10].name)).toBeInTheDocument()
    )
    expect(
      screen.getByText(items[10].name).closest('[role="region"]')
    ).toHaveAccessibleName("team resources")

    const target = items[45]
    view.rerender(
      <SidebarResources
        items={items}
        selected={target.name}
        resourceView={ResourceView.Log}
        pathBuilder={pathBuilder}
        resourceListOptions={DEFAULT_OPTIONS}
      />
    )
    await waitFor(() => expect(sidebarOwner.scrollTop).toBe(460))
    expect(
      sidebarOwner.querySelectorAll("[data-name]").length
    ).toBeLessThanOrEqual(12)
    sidebarOwner
      .querySelectorAll<HTMLElement>('li[aria-hidden="true"]')
      .forEach((spacer) =>
        expect(
          Number(spacer.style.height.replace("px", ""))
        ).toBeGreaterThanOrEqual(0)
      )
    HTMLElement.prototype.getBoundingClientRect = originalRect
  })

  it("positions a stable selected resource after its logical projection arrives", async () => {
    const selected = "uncategorized"
    const logStore = new LogStore()
    const items = Array.from({ length: 175 }, (_, index) => {
      const item = new SidebarItem(
        oneResource({ name: `stable-${index}` }),
        logStore
      )
      item.labels = ["team"]
      return item
    })
    const selectedItem = new SidebarItem(
      oneResource({ name: selected }),
      logStore
    )
    selectedItem.labels = ["team"]
    items.push(selectedItem)

    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight"
    )
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    let owner: HTMLElement | null = null
    let scrollTop = 0
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: function () {
        return this.getAttribute("aria-label") === "Resource logs" ? 90 : 30
      },
    })
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.getAttribute("aria-label") === "Resource logs") {
        owner = this
        return { top: 0, bottom: 90, height: 90 } as DOMRect
      }
      const ownerScrollTop = owner?.scrollTop ?? 0
      if (this.tagName === "UL")
        return {
          top: -ownerScrollTop,
          bottom: -ownerScrollTop,
          height: 0,
        } as DOMRect
      return {
        top: -ownerScrollTop,
        bottom: 30 - ownerScrollTop,
        height: 30,
      } as DOMRect
    }

    try {
      const view = customRender({
        items: [items[0]],
        selected,
        groupState: { team: { expanded: true } },
      })
      const sidebarOwner = screen.getByLabelText("Resource logs") as HTMLElement
      owner = sidebarOwner
      const originalScrollTop = Object.getOwnPropertyDescriptor(
        sidebarOwner,
        "scrollTop"
      )
      Object.defineProperty(sidebarOwner, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (next: number) => {
          scrollTop = next
        },
      })

      try {
        view.rerender(
          <SidebarResources
            items={items}
            selected={selected}
            resourceView={ResourceView.Log}
            pathBuilder={pathBuilder}
            resourceListOptions={DEFAULT_OPTIONS}
          />
        )

        await waitFor(() => {
          const target = document.querySelector<HTMLElement>(
            `[data-name="${selected}"]`
          )
          expect(target).toHaveClass("isSelected")
          expect(target?.getBoundingClientRect().height).toBeGreaterThan(0)
          expect(target).toHaveFocus()
        })
        expect(sidebarOwner.scrollTop).toBeGreaterThan(90)
        expect(
          sidebarOwner.querySelectorAll("[data-name]").length
        ).toBeLessThanOrEqual(9)
      } finally {
        if (originalScrollTop)
          Object.defineProperty(sidebarOwner, "scrollTop", originalScrollTop)
        else Reflect.deleteProperty(sidebarOwner, "scrollTop")
      }
    } finally {
      if (originalClientHeight)
        Object.defineProperty(
          HTMLElement.prototype,
          "clientHeight",
          originalClientHeight
        )
      else Reflect.deleteProperty(HTMLElement.prototype, "clientHeight")
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })

  it("invalidates the virtual origin when the shipped starred link changes chrome", async () => {
    const items = createSidebarItems(24)
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight"
    )
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    let owner: HTMLElement | null = null
    let translatedScrollTop = 0
    const ownerTranslations: number[] = []
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: function () {
        return this.getAttribute("aria-label") === "Resource logs" ? 818 : 20
      },
    })
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.getAttribute("aria-label") === "Resource logs") {
        owner = this
        return { top: 0, height: 818 } as DOMRect
      }
      if (this.tagName === "UL") {
        const starred = !!owner?.querySelector(
          '[aria-label="View starred resource logs"]'
        )
        const scrollTop =
          translatedScrollTop || (starred ? 30 : translatedScrollTop)
        return {
          top: (starred ? 130 : 100) - scrollTop,
          height: 0,
        } as DOMRect
      }
      return { height: 66 } as DOMRect
    }

    try {
      customRender({ items, routeAware: true })
      const sidebarOwner = screen.getByLabelText("Resource logs") as HTMLElement
      owner = sidebarOwner
      Object.defineProperty(sidebarOwner, "scrollTop", {
        configurable: true,
        get: () =>
          translatedScrollTop ||
          (sidebarOwner.querySelector(
            '[aria-label="View starred resource logs"]'
          )
            ? 30
            : 0),
        set: (next: number) => {
          translatedScrollTop = next
          ownerTranslations.push(next)
        },
      })

      userEvent.click(
        screen.getByRole("button", { name: `Star ${items[0].name}` })
      )
      await waitFor(() =>
        expect(
          screen.getByRole("link", { name: "View starred resource logs" })
        ).toBeInTheDocument()
      )

      const target = document.querySelector<HTMLElement>(
        `[data-name="${items[11].name}"]`
      )
      expect(target).not.toBeNull()
      fireEvent.click(target!)
      await waitFor(() => expect(target).toHaveFocus())
      expect(sidebarOwner.scrollTop).toBe(130)
      expect(ownerTranslations).toEqual([130])
      expect(
        sidebarOwner.querySelectorAll("[data-name]").length
      ).toBeLessThanOrEqual(39)

      // Removing the link moves the origin in the opposite direction while
      // preserving the same signed list-local viewport start.
      translatedScrollTop = 100
      userEvent.click(
        screen.getByRole("button", { name: `Unstar ${items[0].name}` })
      )
      await waitFor(() =>
        expect(
          screen.queryByRole("link", { name: "View starred resource logs" })
        ).toBeNull()
      )
      expect(sidebarOwner.scrollTop).toBe(100)
    } finally {
      if (originalClientHeight)
        Object.defineProperty(
          HTMLElement.prototype,
          "clientHeight",
          originalClientHeight
        )
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })

  it("reveals and focuses a keyboard target from a persisted collapsed group", async () => {
    const logStore = new LogStore()
    const item = new SidebarItem(oneResource({ name: "hidden" }), logStore)
    item.labels = ["team"]
    customRender({
      items: [item],
      routeAware: true,
    })

    fireEvent.click(screen.getByRole("button", { name: /team/i }))
    await waitFor(() =>
      expect(screen.queryByText("hidden", { exact: true })).toBeNull()
    )
    fireEvent.keyDown(document.body, { key: "j" })

    await waitFor(() => {
      const target = screen
        .getByText("hidden", { exact: true })
        .closest("[data-name]")
      expect(target).toHaveFocus()
      expect(target).toHaveAttribute("data-occurrence-key", "label:team:hidden")
    })
    expect(screen.getByRole("button", { name: /team/i })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    fireEvent.keyDown(document.body, { key: "k" })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /team/i })).toHaveAttribute(
        "aria-expanded",
        "false"
      )
    )
  })

  it("keeps label-group controls and mounted rows in a labeled controlled region", async () => {
    const logStore = new LogStore()
    const api = new SidebarItem(oneResource({ name: "api" }), logStore)
    api.labels = ["team"]
    customRender({ items: [api] })

    const toggle = screen.getByRole("button", { name: /team/i })
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    const controls = toggle.getAttribute("aria-controls")
    expect(controls).toBeTruthy()
    const region = document.getElementById(controls!)
    expect(region).toHaveAttribute("role", "region")
    expect(region).toHaveAccessibleName(/team resources/i)
    expect(
      within(region!).getByText("api", { exact: true })
    ).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(document.getElementById(controls!)).toHaveAttribute("role", "region")
    expect(screen.queryByText("api", { exact: true })).toBeNull()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(
      within(document.getElementById(controls!)!).getByText("api", {
        exact: true,
      })
    ).toBeInTheDocument()
  })

  it("keeps a clicked duplicate occurrence through same-name route settlement", async () => {
    const logStore = new LogStore()
    const api = new SidebarItem(oneResource({ name: "api" }), logStore)
    api.labels = ["backend", "frontend"]
    const next = new SidebarItem(oneResource({ name: "next" }), logStore)
    next.labels = ["frontend"]
    customRender({ items: [api, next], routeAware: true })

    const duplicate = document.querySelector<HTMLElement>(
      '[data-occurrence-key="label:frontend:api"]'
    )
    expect(duplicate).not.toBeNull()
    fireEvent.click(duplicate!)

    await waitFor(() => expect(duplicate).toHaveFocus())
    fireEvent.keyDown(document.body, { key: "j" })
    await waitFor(() =>
      expect(
        document.querySelector('[data-occurrence-key="label:frontend:next"]')
      ).toHaveFocus()
    )
    fireEvent.keyDown(document.body, { key: "k" })
    await waitFor(() => expect(duplicate).toHaveFocus())
  })

  it("keeps virtual target positioning as the sole owner for duplicate rows", async () => {
    const logStore = new LogStore()
    const api = new SidebarItem(oneResource({ name: "api" }), logStore)
    api.labels = ["backend", "frontend"]
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    const scrollIntoView = jest.fn()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    })

    try {
      customRender({ items: [api], routeAware: true })
      const earlierOccurrence = document.querySelector<HTMLElement>(
        '[data-occurrence-key="label:backend:api"]'
      )
      expect(earlierOccurrence).not.toBeNull()
      fireEvent.click(earlierOccurrence!)

      await waitFor(() => expect(earlierOccurrence).toHaveFocus())
      expect(scrollIntoView).not.toHaveBeenCalled()
      expect(
        document.querySelector('[data-occurrence-key="label:frontend:api"]')
      ).toHaveClass("isSelected")
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      })
    }
  })

  it("keeps its one global shortcut listener active for an empty name filter", () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: true } as Response)
    const item = new SidebarItem(
      oneResource({ name: "selected" }),
      new LogStore()
    )
    customRender({
      items: [item],
      selected: "selected",
      resourceListOptions: {
        ...DEFAULT_OPTIONS,
        resourceNameFilter: "no-match",
      },
    })

    expect(screen.getByText("No matching resources")).toBeInTheDocument()
    expect(() => {
      fireEvent.keyDown(document.body, { key: "j" })
      fireEvent.keyDown(document.body, { key: "k" })
      fireEvent.keyDown(document.body, { key: "r" })
    }).not.toThrow()
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/trigger",
      expect.objectContaining({ method: "post" })
    )
    fetchSpy.mockRestore()
  })

  it("keeps native keyboard traversal on the second same-name occurrence", async () => {
    const logStore = new LogStore()
    const item = new SidebarItem(oneResource({ name: "api" }), logStore)
    item.labels = ["backend", "frontend"]
    customRender({ items: [item], selected: "api", routeAware: true })

    fireEvent.keyDown(document.body, { key: "j" })

    await waitFor(() => {
      const target = document.querySelector<HTMLElement>(
        '[data-occurrence-key="label:frontend:api"]'
      )
      expect(target).not.toBeNull()
      expect(target).toHaveFocus()
    })
  })

  it("drops a completed cross-resource bridge when the route never settles", async () => {
    // A navigation provider whose route action never writes back the `selected`
    // prop: mouse activation can bridge a still-`a` selection to a different
    // resource `b` while virtual positioning completes, but once that pending
    // target settles without a matching route update the bridge must vanish so
    // native traversal resumes from the actual selection, not the stale cursor.
    const logStore = new LogStore()
    const items = ["a", "b", "c"].map(
      (name) => new SidebarItem(oneResource({ name }), logStore)
    )
    const openResource = jest.fn()
    const features = new Features({ [Flag.Labels]: true })
    const addSpy = jest.spyOn(document.body, "addEventListener")
    const removeSpy = jest.spyOn(document.body, "removeEventListener")

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <tiltfileKeyContext.Provider value="test">
          <FeaturesTestProvider value={features}>
            <StarredResourcesContextProvider>
              <ResourceGroupsContextProvider>
                <ResourceListOptionsProvider>
                  <ResourceNavContextProvider
                    value={{
                      selectedResource: "a",
                      invalidResource: "",
                      openResource,
                    }}
                  >
                    <SidebarResources
                      items={items}
                      selected="a"
                      resourceView={ResourceView.Log}
                      pathBuilder={pathBuilder}
                      resourceListOptions={DEFAULT_OPTIONS}
                    />
                  </ResourceNavContextProvider>
                </ResourceListOptionsProvider>
              </ResourceGroupsContextProvider>
            </StarredResourcesContextProvider>
          </FeaturesTestProvider>
        </tiltfileKeyContext.Provider>
      </MemoryRouter>
    )

    // A keyboard request remounts the shortcut listener by design (its `key`
    // tracks the request id), so cumulative `addEventListener` calls grow; the
    // invariant is that exactly one keydown listener stays live — adds and
    // removes stay balanced at a single net registration.
    const netListeners = () =>
      addSpy.mock.calls.filter(([type]) => type === "keydown").length -
      removeSpy.mock.calls.filter(([type]) => type === "keydown").length

    // `data-name` and `data-occurrence-key` share the focus target element.
    const control = (name: string) =>
      document.querySelector<HTMLElement>(
        `[data-occurrence-key="ungrouped:${name}"]`
      )

    // Mouse-activate `b`: the explicit target bridges the still-`a` selection.
    const bRow = control("b")
    expect(bRow).not.toBeNull()
    fireEvent.click(bRow!)

    // Wait for target mount/focus, then for the pending target lifecycle to
    // clear without a matching route settlement.
    await waitFor(() => expect(control("b")).toHaveFocus())
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-occurrence-key="ungrouped:a"]').length
      ).toBe(1)
    )

    expect(netListeners()).toBe(1)

    // Press native `j`. Because `a` remains the actual selection, traversal must
    // choose its immediate next entry `b` — it must not retain the completed
    // bridge and advance from stale cursor `b` to `c`.
    fireEvent.keyDown(document.body, { key: "j" })
    await waitFor(() => expect(openResource).toHaveBeenLastCalledWith("b"))
    expect(openResource).not.toHaveBeenCalledWith("c")
    await waitFor(() => expect(control("b")).toHaveFocus())

    // The pointer bridge is gone, but this new native request is keyboard-owned:
    // `k` reverses from b to a even while the router remains delayed.
    fireEvent.keyDown(document.body, { key: "k" })
    await waitFor(() => expect(openResource).toHaveBeenLastCalledWith("a"))
    fireEvent.keyDown(document.body, { key: "j" })
    await waitFor(() => expect(openResource).toHaveBeenLastCalledWith("b"))

    // No duplicate global shortcut listener and no runaway render loop.
    expect(netListeners()).toBe(1)
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it("keeps a keyboard cursor through delayed route settlement", async () => {
    // Native traversal owns the logical cursor until the navigation provider
    // acknowledges its latest route request. This differs from a pointer
    // bridge: a completed pointer target must not make a failed route look
    // selected, while consecutive keyboard activations compose immediately.
    const logStore = new LogStore()
    const items = ["a", "b", "c"].map(
      (name) => new SidebarItem(oneResource({ name }), logStore)
    )
    const openResource = jest.fn()
    const features = new Features({ [Flag.Labels]: true })
    const addSpy = jest.spyOn(document.body, "addEventListener")
    const removeSpy = jest.spyOn(document.body, "removeEventListener")
    const renderSidebar = (selected: string) => (
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <tiltfileKeyContext.Provider value="test">
          <FeaturesTestProvider value={features}>
            <StarredResourcesContextProvider>
              <ResourceGroupsContextProvider>
                <ResourceListOptionsProvider>
                  <ResourceNavContextProvider
                    value={{
                      selectedResource: selected,
                      invalidResource: "",
                      openResource,
                    }}
                  >
                    <SidebarResources
                      items={items}
                      selected={selected}
                      resourceView={ResourceView.Log}
                      pathBuilder={pathBuilder}
                      resourceListOptions={DEFAULT_OPTIONS}
                    />
                  </ResourceNavContextProvider>
                </ResourceListOptionsProvider>
              </ResourceGroupsContextProvider>
            </StarredResourcesContextProvider>
          </FeaturesTestProvider>
        </tiltfileKeyContext.Provider>
      </MemoryRouter>
    )
    const view = render(renderSidebar("a"))
    const netListeners = () =>
      addSpy.mock.calls.filter(([type]) => type === "keydown").length -
      removeSpy.mock.calls.filter(([type]) => type === "keydown").length

    try {
      fireEvent.keyDown(document.body, { key: "j" })
      fireEvent.keyDown(document.body, { key: "j" })

      await waitFor(() =>
        expect(openResource.mock.calls.map(([name]) => name)).toEqual([
          "b",
          "c",
        ])
      )
      expect(netListeners()).toBe(1)

      // Acknowledging the latest request retains its exact occurrence; `k`
      // must reverse from c even though a and b share the same stale-route path.
      view.rerender(renderSidebar("c"))
      fireEvent.keyDown(document.body, { key: "k" })
      await waitFor(() => expect(openResource).toHaveBeenLastCalledWith("b"))
      expect(netListeners()).toBe(1)
    } finally {
      addSpy.mockRestore()
      removeSpy.mockRestore()
    }
  })

  it("retargets a keyboard cursor when its occurrence changes before route settlement", async () => {
    // Hold route acknowledgement manually so the keyboard request remains the
    // selection owner while a new immutable item projection moves `b` to a
    // different label-derived occurrence. The large tail makes the measured
    // three-viewport mounting bound meaningful in this browser-shaped test.
    const logStore = new LogStore()
    const createItems = (targetLabel: string) => {
      const a = new SidebarItem(oneResource({ name: "a" }), logStore)
      a.labels = ["before"]
      const b = new SidebarItem(oneResource({ name: "b" }), logStore)
      b.labels = [targetLabel]
      const later = Array.from({ length: 160 }, (_, index) => {
        const item = new SidebarItem(
          oneResource({ name: `later-${index}` }),
          logStore
        )
        item.labels = ["after"]
        return item
      })
      return [a, b, ...later]
    }
    const openResource = jest.fn()
    const features = new Features({ [Flag.Labels]: true })
    const renderSidebar = (items: SidebarItem[], selected: string) => (
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <tiltfileKeyContext.Provider value="test">
          <FeaturesTestProvider value={features}>
            <StarredResourcesContextProvider>
              <ResourceGroupsContextProvider>
                <ResourceListOptionsProvider>
                  <ResourceNavContextProvider
                    value={{
                      selectedResource: selected,
                      invalidResource: "",
                      openResource,
                    }}
                  >
                    <SidebarResources
                      items={items}
                      selected={selected}
                      resourceView={ResourceView.Log}
                      pathBuilder={pathBuilder}
                      resourceListOptions={DEFAULT_OPTIONS}
                    />
                  </ResourceNavContextProvider>
                </ResourceListOptionsProvider>
              </ResourceGroupsContextProvider>
            </StarredResourcesContextProvider>
          </FeaturesTestProvider>
        </tiltfileKeyContext.Provider>
      </MemoryRouter>
    )
    const view = render(renderSidebar(createItems("before"), "a"))

    fireEvent.keyDown(document.body, { key: "j" })
    await waitFor(() => {
      const target = document.querySelector<HTMLElement>(
        '[data-occurrence-key="label:before:b"]'
      )
      expect(openResource).toHaveBeenLastCalledWith("b")
      expect(target).toHaveFocus()
    })

    view.rerender(renderSidebar(createItems("after"), "a"))
    await waitFor(() => {
      const target = document.querySelector<HTMLElement>(
        '[data-occurrence-key="label:after:b"]'
      )
      expect(target).toHaveFocus()
      // The owner measures 1,000px and rows measure 20px in this suite.
      // Visible rows plus one viewport of overscan on each side is 150 rows.
      expect(
        screen.getByLabelText("Resource logs").querySelectorAll("[data-name]")
          .length
      ).toBeLessThanOrEqual(150)
    })

    // The stale selected route is still `a`, so both directions must compose
    // from the surviving `b` occurrence rather than a pointer fallback.
    fireEvent.keyDown(document.body, { key: "j" })
    await waitFor(() =>
      expect(openResource).toHaveBeenLastCalledWith("later-0")
    )
    fireEvent.keyDown(document.body, { key: "k" })
    await waitFor(() => expect(openResource).toHaveBeenLastCalledWith("b"))

    // Once the router acknowledges b, the new exact occurrence settles under
    // the ordinary selected-route policy as well.
    view.rerender(renderSidebar(createItems("after"), "b"))
    await waitFor(() => {
      const target = document.querySelector<HTMLElement>(
        '[data-occurrence-key="label:after:b"]'
      )
      expect(target).toHaveClass("isSelected")
      expect(target).toHaveFocus()
    })
  })

  it("keeps All as a keyboard cursor until a delayed route can settle", async () => {
    const logStore = new LogStore()
    const items = ["b", "c"].map(
      (name) => new SidebarItem(oneResource({ name }), logStore)
    )
    const openResource = jest.fn()
    const features = new Features({ [Flag.Labels]: true })

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <tiltfileKeyContext.Provider value="test">
          <FeaturesTestProvider value={features}>
            <StarredResourcesContextProvider>
              <ResourceGroupsContextProvider>
                <ResourceListOptionsProvider>
                  <ResourceNavContextProvider
                    value={{
                      selectedResource: "b",
                      invalidResource: "",
                      openResource,
                    }}
                  >
                    <SidebarResources
                      items={items}
                      selected="b"
                      resourceView={ResourceView.Log}
                      pathBuilder={pathBuilder}
                      resourceListOptions={DEFAULT_OPTIONS}
                    />
                  </ResourceNavContextProvider>
                </ResourceListOptionsProvider>
              </ResourceGroupsContextProvider>
            </StarredResourcesContextProvider>
          </FeaturesTestProvider>
        </tiltfileKeyContext.Provider>
      </MemoryRouter>
    )

    fireEvent.keyDown(document.body, { key: "k" })
    await waitFor(() =>
      expect(openResource).toHaveBeenLastCalledWith(ResourceName.all)
    )
    fireEvent.keyDown(document.body, { key: "j" })

    await waitFor(() =>
      expect(openResource.mock.calls.map(([name]) => name)).toEqual([
        ResourceName.all,
        "b",
      ])
    )
  })

  it("keeps disabled continuation rows at one measured height for narrow names", () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    const longName = "disabled path with enough separate words to wrap narrowly"
    HTMLElement.prototype.getBoundingClientRect = function () {
      const label = this.querySelector<HTMLElement>("[data-name]")
      const wraps =
        !!label &&
        getComputedStyle(label).whiteSpace !== "nowrap" &&
        label.textContent === longName
      return {
        top: 0,
        bottom: wraps ? 48 : 24,
        height: wraps ? 48 : 24,
      } as DOMRect
    }
    const items = ["disabled short", longName, `${longName} again`].map(
      (name) =>
        new SidebarItem(oneResource({ name, disabled: true }), new LogStore())
    )

    try {
      expect(() =>
        customRender({
          items,
          resourceListOptions: {
            ...DEFAULT_OPTIONS,
            showDisabledResources: true,
          },
        })
      ).not.toThrow()
      const rows = items
        .slice(1)
        .map((item) =>
          document
            .querySelector<HTMLElement>(`[data-name="${item.name}"]`)
            ?.closest<HTMLElement>("li")
        )
      expect(rows).toEqual([expect.any(HTMLElement), expect.any(HTMLElement)])
      expect(rows[0]!.getBoundingClientRect().height).toBe(
        rows[1]!.getBoundingClientRect().height
      )
      rows.forEach((row, index) =>
        expect(row?.querySelector("[data-name]")).toHaveAttribute(
          "title",
          items[index + 1].name
        )
      )
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })

  it("keeps collapsible group headings at one measured height for narrow labels", () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    const longLabel = "group label with enough separate words to wrap narrowly"
    HTMLElement.prototype.getBoundingClientRect = function () {
      const label = this.querySelector<HTMLElement>(
        '[id^="sidebar-group-toggle"] span'
      )
      const wraps =
        !!label &&
        getComputedStyle(label).whiteSpace !== "nowrap" &&
        label.textContent === longLabel
      return {
        top: 0,
        bottom: wraps ? 48 : 24,
        height: wraps ? 48 : 24,
      } as DOMRect
    }
    const short = new SidebarItem(
      oneResource({ name: "short" }),
      new LogStore()
    )
    short.labels = ["short label"]
    const long = new SidebarItem(oneResource({ name: "long" }), new LogStore())
    long.labels = [longLabel]

    try {
      expect(() => customRender({ items: [short, long] })).not.toThrow()
      const headings = ["short label", longLabel].map((label) =>
        screen.getByRole("button", { name: new RegExp(label) }).closest("li")
      )
      expect(headings[0]!.getBoundingClientRect().height).toBe(
        headings[1]!.getBoundingClientRect().height
      )
      expect(screen.getByText(longLabel)).toHaveAttribute("title", longLabel)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })

  it("falls back when a pending duplicate occurrence disappears", async () => {
    const logStore = new LogStore()
    const api = new SidebarItem(oneResource({ name: "api" }), logStore)
    api.labels = ["backend", "frontend"]
    const backendItems = Array.from({ length: 60 }, (_, index) => {
      const item = new SidebarItem(
        oneResource({ name: `backend-${index}` }),
        logStore
      )
      item.labels = ["backend"]
      return item
    })
    const next = new SidebarItem(oneResource({ name: "next" }), logStore)
    next.labels = ["backend"]
    const view = customRender({
      items: [...backendItems, api, next],
      selected: "api",
      routeAware: true,
    })

    const requested = document.querySelector<HTMLElement>(
      '[data-occurrence-key="label:frontend:api"]'
    )
    expect(requested).not.toBeNull()
    fireEvent.click(requested!)

    // A route can retain `api` while its label model changes before virtual
    // positioning settles. The first remaining logical occurrence is backend.
    api.labels = ["backend"]
    view.rerender(
      <RouteAwareSidebar
        items={[...backendItems, api, next]}
        selected="api"
        routeAware
        resourceListOptions={DEFAULT_OPTIONS}
      />
    )
    await waitFor(() => {
      const fallback = document.querySelector<HTMLElement>(
        '[data-occurrence-key="label:backend:api"]'
      )
      expect(fallback).not.toBeNull()
    })

    // The fallback is an occurrence identity, not merely the selected name.
    // Its logical neighbors prove keyboard traversal never resumes at the head.
    fireEvent.keyDown(document.body, { key: "j" })
    await waitFor(() =>
      expect(
        document.querySelector('[data-occurrence-key="label:backend:next"]')
      ).toHaveClass("isSelected")
    )
    fireEvent.keyDown(document.body, { key: "k" })
    await waitFor(() =>
      expect(
        document.querySelector('[data-occurrence-key="label:backend:api"]')
      ).toHaveClass("isSelected")
    )
    fireEvent.keyDown(document.body, { key: "k" })
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-occurrence-key="label:backend:backend-59"]'
        )
      ).toHaveClass("isSelected")
    )

    view.rerender(
      <RouteAwareSidebar
        items={backendItems}
        selected="api"
        routeAware
        resourceListOptions={DEFAULT_OPTIONS}
      />
    )
    await waitFor(() =>
      expect(document.querySelector('[data-occurrence-key$=":api"]')).toBeNull()
    )
  })

  describe("disabled resources", () => {
    describe("when feature flag is enabled and `showDisabledResources` option is true", () => {
      let rerender: RenderResult["rerender"]

      beforeEach(() => {
        // Create a list of sidebar items with disable resources interspersed
        const items = createSidebarItems(5)
        items[1].runtimeStatus = ResourceStatus.Disabled
        items[3].runtimeStatus = ResourceStatus.Disabled

        rerender = customRender({
          items,
          resourceListOptions: {
            ...DEFAULT_OPTIONS,
            showDisabledResources: true,
          },
        }).rerender
      })

      it("displays disabled resources list title", () => {
        expect(
          screen.getByText("Disabled", { exact: true })
        ).toBeInTheDocument()
      })

      it("displays disabled resources in their own list", () => {
        const disabledList = screen.getByLabelText("Disabled resources")
        expect(within(disabledList).getByText("_1")).toBeInTheDocument()
        expect(within(disabledList).getByText("_3")).toBeInTheDocument()
      })

      describe("when there is a resource name filter", () => {
        beforeEach(() => {
          // Create a list of sidebar items with disable resources interspersed
          const itemsWithFilter = createSidebarItems(11)
          itemsWithFilter[1].runtimeStatus = ResourceStatus.Disabled
          itemsWithFilter[3].runtimeStatus = ResourceStatus.Disabled
          itemsWithFilter[8].runtimeStatus = ResourceStatus.Disabled

          const options = {
            resourceNameFilter: "1",
            alertsOnTop: true,
            showDisabledResources: true,
          }

          rerender(
            <SidebarResources
              items={itemsWithFilter}
              selected=""
              resourceView={ResourceView.Log}
              pathBuilder={pathBuilder}
              resourceListOptions={options}
            />
          )
        })

        it("displays disabled resources that match the filter", () => {
          // Expect that all matching resources (enabled + disabled) are displayed
          expect(screen.getByText("_1", { exact: true })).toBeInTheDocument()
          expect(screen.getByText("_10", { exact: true })).toBeInTheDocument()

          // Expect that all disabled resources appear in their own section
          expect(
            screen.getByLabelText("Disabled resources")
          ).toBeInTheDocument()
          expect(screen.getByText("_1")).toBeInTheDocument()
        })

        it("does not fabricate an unlabeled region for filtered labeled results", () => {
          const labeled = createSidebarItems(1)
          labeled[0].labels = ["team"]

          rerender(
            <SidebarResources
              items={labeled}
              selected=""
              resourceView={ResourceView.Log}
              pathBuilder={pathBuilder}
              resourceListOptions={{
                ...DEFAULT_OPTIONS,
                resourceNameFilter: labeled[0].name,
              }}
            />
          )

          expect(
            screen.getByText(labeled[0].name, { exact: true })
          ).toBeInTheDocument()
          expect(screen.queryByLabelText("unlabeled resources")).toBeNull()
          expect(screen.queryByRole("region")).toBeNull()
        })
      })

      describe("when there are groups and multiple groups have disabled resources", () => {
        it("displays disabled resources within each group", () => {
          const itemsWithLabels = createSidebarItems(10, true)
          // Add disabled items in different label groups based on hardcoded data
          itemsWithLabels[2].runtimeStatus = ResourceStatus.Disabled
          itemsWithLabels[5].runtimeStatus = ResourceStatus.Disabled

          rerender(
            <SidebarResources
              items={itemsWithLabels}
              selected=""
              resourceView={ResourceView.Log}
              pathBuilder={pathBuilder}
              resourceListOptions={{
                ...DEFAULT_OPTIONS,
                showDisabledResources: true,
              }}
            />
          )

          const disabledLists = screen.getAllByLabelText("Disabled resources")
          expect(disabledLists).toHaveLength(2)
          const disabledRows = disabledLists.flatMap((list) =>
            within(list).getAllByRole("link")
          )
          expect(disabledRows).toHaveLength(2)
          disabledRows.forEach((row) => {
            expect(
              row.closest('[aria-label="Disabled resources"]')
            ).not.toBeNull()
            expect(row.closest('[role="region"]')).not.toBeNull()
          })
        })
      })
    })

    describe("`showDisabledResources` is false", () => {
      it("does NOT display disabled resources at all", () => {
        expect(screen.queryByLabelText("Disabled resources")).toBeNull()
        expect(screen.queryByText("_1", { exact: true })).toBeNull()
        expect(screen.queryByText("_3", { exact: true })).toBeNull()
      })

      it("does NOT display disabled resources list title", () => {
        expect(screen.queryByText("Disabled", { exact: true })).toBeNull()
      })

      describe("when there are groups and an entire group is disabled", () => {
        it("does NOT display the group section", () => {
          const items = createSidebarItems(5, true)
          // Disable the resource that's in the label group with only one resource
          items[3].runtimeStatus = ResourceStatus.Disabled

          customRender({ items })

          // The test data has one group with only disabled resources,
          // so expect that it doesn't show up
          expect(screen.queryByText("very_long_long_long_label")).toBeNull()
        })
      })
    })
  })
})
