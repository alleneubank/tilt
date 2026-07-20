import { render, RenderResult } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import React from "react"
import { MemoryRouter } from "react-router"
import LogStore from "./LogStore"
import { ResourceNavContextProvider } from "./ResourceNav"
import SidebarItem from "./SidebarItem"
import { ResourceVirtualResourceEntry } from "./ResourceVirtualModel"
import SidebarKeyboardShortcuts, {
  OccurrenceCursorRequest,
} from "./SidebarKeyboardShortcuts"
import { nResourceView } from "./testdata"
import { ResourceName, ResourceView } from "./types"

describe("SidebarKeyboardShortcuts", () => {
  const logStore = new LogStore()
  const sidebarItems = nResourceView(2).uiResources.map(
    (r) => new SidebarItem(r, logStore)
  )
  const items: ReadonlyArray<ResourceVirtualResourceEntry<SidebarItem>> =
    sidebarItems.map((item, index) => ({
      kind: "resource",
      occurrenceKey: `ungrouped:${item.name}`,
      resourceName: item.name,
      groupId: "ungrouped",
      item,
      resourceIndex: index,
      groupIndex: index,
      layoutKey: "default",
    }))
  let rerender: RenderResult["rerender"]
  let openResourceSpy: jest.Mock
  let onStartBuildSpy: jest.Mock
  let onRequestOccurrenceSpy: jest.Mock
  let onRequestAllSpy: jest.Mock

  beforeEach(() => {
    openResourceSpy = jest.fn()
    onStartBuildSpy = jest.fn()
    onRequestOccurrenceSpy = jest.fn()
    onRequestAllSpy = jest.fn()

    const resourceNavValue = {
      selectedResource: "",
      invalidResource: "",
      openResource: openResourceSpy,
    }

    rerender = render(
      <SidebarKeyboardShortcuts
        items={items}
        selected=""
        resourceView={ResourceView.Log}
        onStartBuild={onStartBuildSpy}
        onRequestOccurrence={onRequestOccurrenceSpy}
        onRequestAll={onRequestAllSpy}
      />,
      {
        wrapper: ({ children }) => (
          <MemoryRouter
            initialEntries={["/init"]}
            future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          >
            <ResourceNavContextProvider value={resourceNavValue}>
              {children}
            </ResourceNavContextProvider>
          </MemoryRouter>
        ),
      }
    ).rerender
  })

  it("navigates forwards on 'j'", () => {
    expect(openResourceSpy).not.toHaveBeenCalled()

    userEvent.keyboard("j")

    expect(openResourceSpy).toHaveBeenCalledWith(items[0].resourceName)
    expect(onRequestOccurrenceSpy).toHaveBeenCalledWith(items[0], "keyboard")
  })

  it("navigates forwards on 'j' without wrapping", () => {
    // Select the last resource item
    rerender(
      <SidebarKeyboardShortcuts
        items={items}
        selected={items[1].resourceName}
        resourceView={ResourceView.Log}
        onStartBuild={onStartBuildSpy}
        onRequestOccurrence={onRequestOccurrenceSpy}
        onRequestAll={onRequestAllSpy}
      />
    )

    userEvent.keyboard("j")

    expect(openResourceSpy).not.toHaveBeenCalled()
  })

  it("navigates backward on 'k'", () => {
    // Select the last resource item
    rerender(
      <SidebarKeyboardShortcuts
        items={items}
        selected={items[1].resourceName}
        resourceView={ResourceView.Log}
        onStartBuild={onStartBuildSpy}
        onRequestOccurrence={onRequestOccurrenceSpy}
        onRequestAll={onRequestAllSpy}
      />
    )

    userEvent.keyboard("k")

    expect(openResourceSpy).toHaveBeenCalledWith(items[0].resourceName)
  })

  it("navigates backward on 'k' without wrapping", () => {
    userEvent.keyboard("k")

    expect(openResourceSpy).not.toHaveBeenCalled()
  })

  it("treats Starred as immediately before All when it is an external selection", () => {
    rerender(
      <SidebarKeyboardShortcuts
        items={items}
        selected={ResourceName.starred}
        resourceView={ResourceView.Log}
        onStartBuild={onStartBuildSpy}
        onRequestOccurrence={onRequestOccurrenceSpy}
        onRequestAll={onRequestAllSpy}
      />
    )

    userEvent.keyboard("j")
    userEvent.keyboard("k")

    expect(onRequestAllSpy).toHaveBeenCalledTimes(1)
    expect(openResourceSpy).toHaveBeenCalledWith(ResourceName.all)
    expect(onRequestOccurrenceSpy).not.toHaveBeenCalled()
  })

  it("uses the durable aggregate cursor before a delayed All route settles", () => {
    const aggregateCursor: OccurrenceCursorRequest = {
      kind: "aggregate",
      resourceName: ResourceName.all,
      requestId: 1,
      origin: "keyboard",
      phase: "settled",
    }
    rerender(
      <SidebarKeyboardShortcuts
        items={items}
        selected={items[1].resourceName}
        resourceView={ResourceView.Log}
        onStartBuild={onStartBuildSpy}
        onRequestOccurrence={onRequestOccurrenceSpy}
        onRequestAll={onRequestAllSpy}
        cursorRequest={aggregateCursor}
      />
    )

    userEvent.keyboard("j")

    expect(onRequestOccurrenceSpy).toHaveBeenCalledWith(items[0], "keyboard")
    expect(openResourceSpy).toHaveBeenCalledWith(items[0].resourceName)
  })

  it("triggers update on 'r'", () => {
    expect(onStartBuildSpy).not.toHaveBeenCalled()

    userEvent.keyboard("r")

    expect(onStartBuildSpy).toHaveBeenCalled()
  })
})
