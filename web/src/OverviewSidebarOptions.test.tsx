import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import React, { ReactElement } from "react"
import { MemoryRouter } from "react-router"
import { accessorsForTesting, tiltfileKeyContext } from "./BrowserStorage"
import Features, { FeaturesTestProvider, Flag } from "./feature"
import {
  TenResourcesWithLabels,
  TestsWithErrors,
  TwoResourcesTwoTests,
} from "./OverviewResourceSidebar.stories"
import { OverviewSidebarOptionsRoot } from "./OverviewSidebarOptions"
import { ResourceGroupsContextProvider } from "./ResourceGroupsContext"
import {
  DEFAULT_OPTIONS,
  ResourceListOptions,
  ResourceListOptionsProvider,
  RESOURCE_LIST_OPTIONS_KEY,
} from "./ResourceListOptionsContext"
import { ResourceNameFilterTextField } from "./ResourceNameFilter"
import { SidebarItemNameRoot, SidebarItemRoot } from "./SidebarItemView"
import {
  SidebarListSectionItemsRoot,
  SidebarResourcesRoot,
} from "./SidebarResources"

const resourceListOptionsAccessor = accessorsForTesting<ResourceListOptions>(
  RESOURCE_LIST_OPTIONS_KEY,
  sessionStorage
)
/**
 * TODO (lizz): These tests behave more like integration tests
 * and test the SidebarOptions component within the larger `SidebarResources`
 * component. The tests should be moved over to that component's test suite
 * and refactored with the react-testing-library changes.
 */

function assertSidebarItemsAndOptions(
  root: HTMLElement,
  names: string[],
  expectAlertsOnTop: boolean,
  expectedResourceNameFilter?: string
) {
  let sidebar = Array.from(root.querySelectorAll(SidebarResourcesRoot))
  expect(sidebar).toHaveLength(1)

  // only check items in the "all resources" section, i.e. don't look at starred things
  // or we'll have duplicates
  let all = sidebar[0].querySelector(SidebarListSectionItemsRoot)!
  let items = Array.from(all.querySelectorAll(SidebarItemRoot))
  const observedNames = items.map(
    (i) => i.querySelector(SidebarItemNameRoot)?.textContent
  )
  expect(observedNames).toEqual(names)

  let optSetter = Array.from(
    sidebar[0].querySelectorAll(OverviewSidebarOptionsRoot)
  )
  expect(optSetter).toHaveLength(1)

  let checkbox = optSetter[0].querySelector(
    "input[type=checkbox]"
  ) as HTMLInputElement
  expect(checkbox.checked).toEqual(expectAlertsOnTop)
  if (expectedResourceNameFilter !== undefined) {
    expect(
      optSetter[0].querySelector(ResourceNameFilterTextField)!.textContent
    ).toEqual(expectedResourceNameFilter)
  }
}

beforeEach(() => {})

let originalClientHeight: PropertyDescriptor | undefined
let originalRect: typeof HTMLElement.prototype.getBoundingClientRect

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeAll(() => {
  // jsdom deliberately has no layout. This is a narrow, browser-shaped layout
  // fixture so the integration test exercises production's fail-closed path.
  originalClientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight"
  )
  originalRect = HTMLElement.prototype.getBoundingClientRect
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.getAttribute("aria-label") === "Resource logs" ? 240 : 24
    },
  })
  HTMLElement.prototype.getBoundingClientRect = function () {
    const isOwner = this.getAttribute("aria-label") === "Resource logs"
    const top = isOwner ? 0 : 48
    return { top, bottom: top + 24, height: 24 } as DOMRect
  }
})

afterAll(() => {
  if (originalClientHeight)
    Object.defineProperty(
      HTMLElement.prototype,
      "clientHeight",
      originalClientHeight
    )
  HTMLElement.prototype.getBoundingClientRect = originalRect
})

afterEach(() => {
  localStorage.clear()
  resourceListOptionsAccessor.set({
    ...DEFAULT_OPTIONS,
  })
})

function renderContainer(x: ReactElement) {
  const features = new Features({
    [Flag.Labels]: true,
  })
  const { container } = render(
    <MemoryRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <FeaturesTestProvider value={features}>
        <tiltfileKeyContext.Provider value="test">
          <ResourceGroupsContextProvider>
            <ResourceListOptionsProvider>{x}</ResourceListOptionsProvider>
          </ResourceGroupsContextProvider>
        </tiltfileKeyContext.Provider>
      </FeaturesTestProvider>
    </MemoryRouter>
  )
  return container
}

describe("overview sidebar options", () => {
  it("says no matches found", () => {
    resourceListOptionsAccessor.set({
      ...DEFAULT_OPTIONS,
      resourceNameFilter: "asdfawfwef",
    })
    const container = renderContainer(<TwoResourcesTwoTests />)
    const resourceSectionItems = Array.from(
      container
        .querySelector(SidebarListSectionItemsRoot)!
        .querySelectorAll("li")
    )
    expect(resourceSectionItems.map((n) => n.textContent)).toEqual([
      "No matching resources",
    ])
  })
})

it("toggles/untoggles Alerts On Top sorting when button clicked", () => {
  // The story helper is normally decorated with this provider. Keep the
  // direct integration render equivalent to the real sidebar tree.
  const { container } = render(
    <ResourceGroupsContextProvider>
      {TestsWithErrors()}
    </ResourceGroupsContextProvider>
  )

  const origOrder = [
    "(Tiltfile)",
    "test_0",
    "test_1",
    "test_2",
    "test_3",
    "test_4",
    "test_5",
    "test_6",
    "test_7",
  ]
  const alertsOnTopOrder = [
    "test_0",
    "test_2",
    "test_4",
    "test_6",
    "(Tiltfile)",
    "test_1",
    "test_3",
    "test_5",
    "test_7",
  ]
  assertSidebarItemsAndOptions(container, origOrder, false)

  let aotToggle = screen.getByLabelText("Alerts on top")
  userEvent.click(aotToggle)

  assertSidebarItemsAndOptions(container, alertsOnTopOrder, true)

  userEvent.click(aotToggle)
  assertSidebarItemsAndOptions(container, origOrder, false)
})
