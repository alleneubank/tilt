import { render, RenderOptions, screen } from "@testing-library/react"
import React from "react"
import Features, { FeaturesTestProvider } from "./feature"
import { LogAlertIndex } from "./LogStore"
import PathBuilder from "./PathBuilder"
import SidebarItem from "./SidebarItem"
import SidebarItemView, { SidebarItemRoot } from "./SidebarItemView"
import {
  computeResourceVirtualRange,
  resourceVirtualEntryKey,
} from "./ResourceVirtualRange"
import { ResourceVirtualEntry } from "./ResourceVirtualModel"
import { oneResource, TestResourceOptions } from "./testdata"
import { ResourceView } from "./types"

const PATH_BUILDER = PathBuilder.forTesting("localhost", "/")
const LOG_ALERT_INDEX: LogAlertIndex = { alertsForSpanId: () => [] }

function customRender(sidebarItem: SidebarItem, options?: RenderOptions) {
  const features = new Features(null)
  return render(
    <SidebarItemView
      item={sidebarItem}
      selected={false}
      resourceView={ResourceView.Log}
      pathBuilder={PATH_BUILDER}
      groupView={false}
    />,
    {
      wrapper: ({ children }) => (
        <FeaturesTestProvider value={features}>{children}</FeaturesTestProvider>
      ),
      ...options,
    }
  )
}

const oneSidebarItem = (options: TestResourceOptions) => {
  return new SidebarItem(oneResource(options), LOG_ALERT_INDEX)
}

describe("SidebarItemView", () => {
  it("does display a disabled resource with disabled view", () => {
    const item = oneSidebarItem({ disabled: true })
    customRender(item)

    expect(screen.getByText(item.name)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: item.name })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /star/i })).toBeInTheDocument()
    expect(screen.queryByLabelText("Trigger update")).toBeNull()
  })

  it("does render an enabled resource with enabled view", () => {
    const item = oneSidebarItem({ disabled: false })
    customRender(item)

    expect(screen.getByText(item.name)).toBeInTheDocument()
    expect(
      screen.getAllByRole("button", { name: /star/i })[0]
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Trigger update")).toBeInTheDocument()
  })

  it("measures continuation spacing inside each virtual row footprint", () => {
    const flowPadding = (selector: string) =>
      Number.parseFloat(
        (
          Array.from(document.styleSheets)
            .flatMap((sheet) => Array.from(sheet.cssRules))
            .find(
              (rule) =>
                "selectorText" in rule &&
                (rule as CSSStyleRule).selectorText.includes(selector)
            ) as CSSStyleRule | undefined
        )?.style.getPropertyValue("padding-top") || "0"
      )
    const continuationFlowHeight = flowPadding(".resourceVirtualContinuation")
    const disabledContinuationFlowHeight = flowPadding(
      ".resourceVirtualContinuation.isDisabled"
    )
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () {
      return {
        height:
          20 +
          (this.classList.contains("resourceVirtualContinuation")
            ? this.classList.contains("isDisabled")
              ? disabledContinuationFlowHeight
              : continuationFlowHeight
            : 0),
      } as DOMRect
    }
    const entries: ReadonlyArray<ResourceVirtualEntry<string>> = [
      {
        kind: "resource",
        occurrenceKey: "enabled:leading",
        resourceName: "leading",
        groupId: "group",
        item: "leading",
        resourceIndex: 0,
        groupIndex: 0,
        layoutKey: "enabled-leading",
      },
      {
        kind: "resource",
        occurrenceKey: "enabled:continuation",
        resourceName: "continuation",
        groupId: "group",
        item: "continuation",
        resourceIndex: 1,
        groupIndex: 1,
        layoutKey: "enabled-continuation",
      },
      {
        kind: "resource",
        occurrenceKey: "enabled:tail",
        resourceName: "tail",
        groupId: "group",
        item: "tail",
        resourceIndex: 2,
        groupIndex: 2,
        layoutKey: "enabled-continuation",
      },
    ]

    try {
      const { container } = render(
        <ul>
          <SidebarItemRoot data-row="leading" />
          <SidebarItemRoot
            className="resourceVirtualContinuation"
            data-row="continuation"
          />
          <SidebarItemRoot
            className="resourceVirtualContinuation"
            data-row="tail"
          />
          <SidebarItemRoot
            className="resourceVirtualContinuation isDisabled"
            data-row="disabled-continuation"
          />
        </ul>
      )
      const leading = container.querySelector<HTMLElement>(
        '[data-row="leading"]'
      )
      const continuation = container.querySelector<HTMLElement>(
        '[data-row="continuation"]'
      )
      const tail = container.querySelector<HTMLElement>('[data-row="tail"]')
      const disabledContinuation = container.querySelector<HTMLElement>(
        '[data-row="disabled-continuation"]'
      )
      if (!leading || !continuation || !tail || !disabledContinuation)
        throw new Error("Expected virtual rows")

      expect(continuationFlowHeight).toBeCloseTo(11.2)
      expect(disabledContinuationFlowHeight).toBe(2)
      expect(leading.getBoundingClientRect().height).toBe(20)
      expect(continuation.getBoundingClientRect().height).toBeCloseTo(31.2)
      expect(tail.getBoundingClientRect().height).toBeCloseTo(31.2)
      expect(disabledContinuation.getBoundingClientRect().height).toBe(22)

      const entryHeights = new Map(
        entries.map((entry, index) => [
          resourceVirtualEntryKey(entry),
          [leading, continuation, tail][index].getBoundingClientRect().height,
        ])
      )
      const range = computeResourceVirtualRange(entries, {
        viewportHeight: 20,
        scrollTop: 0,
        resourceHeights: new Map([
          ["enabled-leading", leading.getBoundingClientRect().height],
          ["enabled-continuation", continuation.getBoundingClientRect().height],
        ]),
        structuralHeights: new Map(),
        entryHeights,
      })

      expect(range.totalHeight).toBeCloseTo(82.4)
      expect(
        computeResourceVirtualRange(entries, {
          viewportHeight: 20,
          scrollTop: 0,
          resourceHeights: new Map([
            ["enabled-leading", leading.getBoundingClientRect().height],
            [
              "enabled-continuation",
              continuation.getBoundingClientRect().height,
            ],
          ]),
          structuralHeights: new Map(),
          entryHeights,
          targetKey: "enabled:tail",
        }).anchorAdjustment
      ).toBeCloseTo(51.2)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })
})
