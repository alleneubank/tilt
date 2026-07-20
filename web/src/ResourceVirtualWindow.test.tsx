import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import React from "react"
import { ResourceVirtualEntry } from "./ResourceVirtualModel"
import { ResourceVirtualWindow } from "./ResourceVirtualWindow"
import { RESOURCE_VIRTUAL_BOOTSTRAP_SIZE } from "./ResourceVirtualRange"

class ResizeObserverStub {
  static observers: ResizeObserverStub[] = []
  readonly observed: Element[] = []
  callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    ResizeObserverStub.observers.push(this)
  }
  observe(element: Element) {
    this.observed.push(element)
  }
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
    get: () => 20,
  })
  jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    height: 20,
  } as DOMRect)
})

const entries: ReadonlyArray<ResourceVirtualEntry<string>> = Array.from(
  { length: 50 },
  (_, index) => ({
    kind: "resource" as const,
    occurrenceKey: `row:${index}`,
    resourceName: `row-${index}`,
    groupId: "ungrouped",
    item: `row-${index}`,
    resourceIndex: index,
    groupIndex: index,
    layoutKey: "default",
  })
)

it("bootstraps one logical item without rendering every resource", () => {
  render(
    <div aria-label="owner">
      <ResourceVirtualWindow
        entries={entries}
        renderEntry={(entry) => (
          <span>
            {entry.kind === "resource" ? entry.resourceName : entry.kind}
          </span>
        )}
      />
    </div>
  )
  expect(screen.getByText("row-0")).toBeInTheDocument()
  expect(screen.queryByText("row-49")).toBeNull()
})

it("keeps an empty sequence geometry-free and calibrates structural-only semantics", () => {
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    value: 20,
  })
  document.body.appendChild(owner)
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ height: 20 } as DOMRect)
  const structuralOnly: ReadonlyArray<ResourceVirtualEntry<string>> = [
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

  const view = render(
    <ResourceVirtualWindow
      entries={[]}
      scrollOwnerRef={{ current: owner }}
      renderEntry={(entry, onElement) => (
        <span ref={onElement}>{entry.kind}</span>
      )}
    />,
    { container: owner }
  )
  expect(owner.querySelectorAll("span")).toHaveLength(0)

  view.rerender(
    <ResourceVirtualWindow
      entries={structuralOnly}
      scrollOwnerRef={{ current: owner }}
      renderEntry={(entry, onElement) => (
        <span ref={onElement} data-kind={entry.kind}>
          {entry.kind === "group-header" ? entry.label : entry.kind}
        </span>
      )}
    />
  )
  expect(screen.getByText("Group")).toBeInTheDocument()
  expect(owner.querySelectorAll('[data-kind="resource"]')).toHaveLength(0)
  view.rerender(
    <ResourceVirtualWindow
      entries={entries.slice(0, 1)}
      scrollOwnerRef={{ current: owner }}
      renderEntry={(entry, onElement) => (
        <span ref={onElement} data-kind={entry.kind}>
          {entry.kind === "resource" ? entry.resourceName : entry.kind}
        </span>
      )}
    />
  )
  expect(screen.getByText("row-0")).toBeInTheDocument()
  view.rerender(
    <ResourceVirtualWindow
      entries={[]}
      scrollOwnerRef={{ current: owner }}
      renderEntry={(entry, onElement) => (
        <span ref={onElement}>{entry.kind}</span>
      )}
    />
  )
  expect(owner.querySelectorAll('[data-kind="resource"]')).toHaveLength(0)
  HTMLElement.prototype.getBoundingClientRect = originalRect
  owner.remove()
})

it("bootstraps a positive owner from its requested resource before measuring geometry", () => {
  const viewportHeight = 818
  const actualRowHeight = 66
  const measuredViewportCapacity = Math.ceil(viewportHeight / actualRowHeight)
  const resourceBound = measuredViewportCapacity * 3
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    value: viewportHeight,
  })
  document.body.appendChild(owner)
  const ownerRef = { current: owner }
  const initialRefResources: string[] = []
  const initialMountedResources: string[] = []
  let firstCommit = true
  const onMounted = jest.fn((entry: ResourceVirtualEntry<string>) => {
    if (firstCommit && entry.kind === "resource")
      initialMountedResources.push(entry.occurrenceKey)
  })
  const frameCallbacks: FrameRequestCallback[] = []
  const requestFrame = jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ height: actualRowHeight } as DOMRect)
  const targetKey = "row:175"
  const entriesWithStructuralHeaders: ReadonlyArray<
    ResourceVirtualEntry<string>
  > = Array.from({ length: 176 }, (_, index) => ({
    kind: "resource" as const,
    occurrenceKey: `row:${index}`,
    resourceName: `row-${index}`,
    groupId: "ungrouped",
    item: `row-${index}`,
    resourceIndex: index,
    groupIndex: index,
    layoutKey: "default",
  })).flatMap((entry, index) =>
    index === 175
      ? [
          {
            kind: "group-header" as const,
            groupId: "tail",
            label: "Tail",
            expanded: true,
            members: [],
            memberCount: 1,
            collapsible: true,
            layoutKey: "group-header",
          },
          entry,
        ]
      : [entry]
  )

  try {
    render(
      <ResourceVirtualWindow
        entries={entriesWithStructuralHeaders}
        scrollOwnerRef={ownerRef}
        targetKey={targetKey}
        onMounted={onMounted}
        renderEntry={(entry, onElement) => (
          <span
            ref={(element) => {
              if (!element) firstCommit = false
              else if (firstCommit && entry.kind === "resource")
                initialRefResources.push(entry.occurrenceKey)
              onElement(element)
            }}
            data-kind={entry.kind}
          >
            {entry.kind === "resource"
              ? entry.resourceName
              : entry.kind === "group-header"
              ? entry.label
              : entry.kind}
          </span>
        )}
      />,
      { container: owner }
    )

    expect(initialRefResources).toEqual([targetKey])
    expect(initialMountedResources).toEqual([targetKey])

    act(() => frameCallbacks.forEach((callback) => callback(0)))
    act(() => frameCallbacks.splice(0).forEach((callback) => callback(1)))
    act(() => frameCallbacks.splice(0).forEach((callback) => callback(2)))
    const settledResources = owner.querySelectorAll('[data-kind="resource"]')
    const settledStructuralHeaders = owner.querySelectorAll(
      '[data-kind="group-header"]'
    )
    expect(settledResources.length).toBeLessThanOrEqual(resourceBound)
    expect(settledResources.length).toBeGreaterThan(
      RESOURCE_VIRTUAL_BOOTSTRAP_SIZE
    )
    expect(settledStructuralHeaders.length).toBeLessThanOrEqual(1)
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    requestFrame.mockRestore()
    owner.remove()
  }
})

it("settles a calibration target only after authoritative geometry retains its viewport", () => {
  const viewportHeight = 60
  const regularHeight = 20
  const targetHeight = 30
  const resourceBound = Math.ceil(viewportHeight / regularHeight) * 3
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    value: viewportHeight,
  })
  document.body.appendChild(owner)
  const frames: FrameRequestCallback[] = []
  const requestFrame = jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    switch (this.getAttribute("data-layout")) {
      case "regular":
        return { height: regularHeight } as DOMRect
      case "target":
        return { height: targetHeight } as DOMRect
      case "group-header":
        return { height: 10 } as DOMRect
      case "disabled-header":
        return { height: 15 } as DOMRect
      default:
        return { height: regularHeight } as DOMRect
    }
  }
  const targetKey = "target:tail"
  const entries: ReadonlyArray<ResourceVirtualEntry<string>> = [
    ...Array.from({ length: 16 }, (_, index) => ({
      kind: "resource" as const,
      occurrenceKey: `regular:${index}`,
      resourceName: `regular-${index}`,
      groupId: "regular",
      item: `regular-${index}`,
      resourceIndex: index,
      groupIndex: index,
      layoutKey: "regular",
    })),
    {
      kind: "group-header" as const,
      groupId: "tail",
      label: "Tail",
      expanded: true,
      members: [],
      memberCount: 1,
      collapsible: true,
      layoutKey: "group-header",
    },
    {
      kind: "resource" as const,
      occurrenceKey: targetKey,
      resourceName: "target",
      groupId: "tail",
      item: "target",
      resourceIndex: 16,
      groupIndex: 0,
      layoutKey: "target",
    },
    {
      kind: "disabled-header" as const,
      sectionId: "disabled",
      groupId: "tail",
      memberCount: 0,
      layoutKey: "disabled-header",
    },
  ]
  const completions = jest.fn()
  const observedLayouts = new Set<string>()
  const completionLayouts: string[][] = []

  function CalibrationSettlementHarness() {
    const [target, setTarget] = React.useState<string | undefined>(targetKey)
    return (
      <ResourceVirtualWindow
        entries={entries}
        scrollOwnerRef={{ current: owner }}
        targetKey={target}
        onTargetMounted={(key) => {
          completionLayouts.push(Array.from(observedLayouts).sort())
          completions(key)
          setTarget(undefined)
        }}
        onMounted={(entry) => observedLayouts.add(entry.layoutKey)}
        renderEntry={(entry, onElement) => (
          <span
            ref={onElement}
            data-kind={entry.kind}
            data-layout={entry.layoutKey}
            data-resource={
              entry.kind === "resource" ? entry.occurrenceKey : undefined
            }
          >
            {entry.kind === "resource"
              ? entry.resourceName
              : entry.kind === "group-header"
              ? entry.label
              : entry.sectionId}
          </span>
        )}
      />
    )
  }

  try {
    render(<CalibrationSettlementHarness />, { container: owner })

    for (let frame = 0; frame < 8 && !completions.mock.calls.length; frame++) {
      act(() => frames.splice(0).forEach((callback) => callback(frame)))
      expect(
        owner.querySelectorAll('[data-kind="resource"]').length
      ).toBeLessThanOrEqual(resourceBound)
    }

    expect(completions).toHaveBeenCalledTimes(1)
    expect(completions).toHaveBeenCalledWith(targetKey)
    // The target first mounts as the one-entry probe. Completion may only
    // consume the parent request once every current layout class is measured.
    expect(completionLayouts).toEqual([
      ["disabled-header", "group-header", "regular", "target"],
    ])
    expect(owner.scrollTop).toBeGreaterThan(0)
    expect(owner.querySelector(`[data-resource="${targetKey}"]`)).not.toBeNull()
    expect(
      owner.querySelectorAll('[data-kind="resource"]').length
    ).toBeLessThanOrEqual(resourceBound)
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    requestFrame.mockRestore()
    owner.remove()
  }
})

it("calibrates mixed resource layouts without exceeding the measured median bound", () => {
  const viewportHeight = 818
  const enabledHeight = 66
  const disabledHeight = 29
  const mixedEntries: ReadonlyArray<ResourceVirtualEntry<string>> = [
    ...Array.from({ length: 27 }, (_, index) => ({
      kind: "resource" as const,
      occurrenceKey: `enabled:${index}`,
      resourceName: `enabled-${index}`,
      groupId: "group",
      item: `enabled-${index}`,
      resourceIndex: index,
      groupIndex: index,
      layoutKey: "enabled",
    })),
    ...Array.from({ length: 80 }, (_, index) => ({
      kind: "resource" as const,
      occurrenceKey: `disabled:${index}`,
      resourceName: `disabled-${index}`,
      groupId: "group",
      item: `disabled-${index}`,
      resourceIndex: index + 27,
      groupIndex: index + 27,
      layoutKey: "disabled",
    })),
  ]
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    value: viewportHeight,
  })
  document.body.appendChild(owner)
  const frames: FrameRequestCallback[] = []
  const requestFrame = jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      height:
        this.getAttribute("data-layout") === "enabled"
          ? enabledHeight
          : disabledHeight,
    } as DOMRect
  }

  try {
    render(
      <ResourceVirtualWindow
        entries={mixedEntries}
        scrollOwnerRef={{ current: owner }}
        renderEntry={(entry, onElement) => (
          <span
            ref={onElement}
            data-kind={entry.kind}
            data-layout={
              entry.kind === "resource" && entry.resourceIndex < 27
                ? "enabled"
                : "disabled"
            }
          >
            {entry.kind === "resource" ? entry.resourceName : entry.kind}
          </span>
        )}
      />,
      { container: owner }
    )

    owner.scrollTop = 1000
    fireEvent.scroll(owner)
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    act(() => frames.splice(0).forEach((callback) => callback(1)))
    owner.scrollTop = viewportHeight
    fireEvent.scroll(owner)
    act(() => frames.splice(0).forEach((callback) => callback(2)))
    const mountedHeights = Array.from(
      owner.querySelectorAll<HTMLElement>('[data-kind="resource"]')
    ).map((element) => element.getBoundingClientRect().height)
    const median = [...mountedHeights].sort((a, b) => a - b)[
      Math.floor(mountedHeights.length / 2)
    ]
    const independentBound = Math.ceil(viewportHeight / median) * 3
    expect(mountedHeights.length).toBeLessThanOrEqual(independentBound)
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    requestFrame.mockRestore()
    owner.remove()
  }
})

it("calibrates four missing resource layouts one contiguous entry at a time", () => {
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    value: 10,
  })
  document.body.appendChild(owner)
  const frames: FrameRequestCallback[] = []
  const requestFrame = jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
  const fourLayouts: ReadonlyArray<ResourceVirtualEntry<string>> = [
    "enabled-leading",
    "enabled-continuation",
    "disabled-leading",
    "disabled-continuation",
  ].map((layoutKey, index) => ({
    ...entries[index],
    layoutKey,
  }))
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ height: 20 } as DOMRect)

  try {
    render(
      <ResourceVirtualWindow
        entries={fourLayouts}
        scrollOwnerRef={{ current: owner }}
        renderEntry={(entry, onElement) => (
          <span ref={onElement} data-kind={entry.kind}>
            {entry.kind === "resource" ? entry.resourceName : entry.kind}
          </span>
        )}
      />,
      { container: owner }
    )

    for (let index = 0; index < 3; index++) {
      expect(owner.querySelectorAll('[data-kind="resource"]')).toHaveLength(1)
      act(() => frames.splice(0).forEach((callback) => callback(index)))
    }
    act(() => frames.splice(0).forEach((callback) => callback(3)))
    expect(owner.querySelectorAll('[data-kind="resource"]')).toHaveLength(1)
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    requestFrame.mockRestore()
    owner.remove()
  }
})

it("calibrates a short explicit target without expanding to the mixed logical range", () => {
  const viewportHeight = 818
  const enabledHeight = 66
  const disabledHeight = 29
  const mixedEntries: ReadonlyArray<ResourceVirtualEntry<string>> = [
    ...Array.from({ length: 27 }, (_, index) => ({
      kind: "resource" as const,
      occurrenceKey: `enabled:${index}`,
      resourceName: `enabled-${index}`,
      groupId: "group",
      item: `enabled-${index}`,
      resourceIndex: index,
      groupIndex: index,
      layoutKey: "enabled",
    })),
    ...Array.from({ length: 80 }, (_, index) => ({
      kind: "resource" as const,
      occurrenceKey: `disabled:${index}`,
      resourceName: `disabled-${index}`,
      groupId: "group",
      item: `disabled-${index}`,
      resourceIndex: index + 27,
      groupIndex: index + 27,
      layoutKey: "disabled",
    })),
  ]
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    value: viewportHeight,
  })
  document.body.appendChild(owner)
  const initialResources: string[] = []
  let firstCommit = true
  const frames: FrameRequestCallback[] = []
  const requestFrame = jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      height:
        this.getAttribute("data-layout") === "enabled"
          ? enabledHeight
          : disabledHeight,
    } as DOMRect
  }

  try {
    render(
      <ResourceVirtualWindow
        entries={mixedEntries}
        scrollOwnerRef={{ current: owner }}
        targetKey="disabled:0"
        renderEntry={(entry, onElement) => (
          <span
            ref={(element) => {
              if (!element) firstCommit = false
              else if (firstCommit && entry.kind === "resource")
                initialResources.push(entry.occurrenceKey)
              onElement(element)
            }}
            data-kind={entry.kind}
            data-layout={
              entry.kind === "resource" ? entry.layoutKey : undefined
            }
          >
            {entry.kind === "resource" ? entry.resourceName : entry.kind}
          </span>
        )}
      />,
      { container: owner }
    )

    expect(initialResources).toEqual(["disabled:0"])
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    const mountedHeights = Array.from(
      owner.querySelectorAll<HTMLElement>('[data-kind="resource"]')
    ).map((element) => element.getBoundingClientRect().height)
    const median = [...mountedHeights].sort((a, b) => a - b)[
      Math.floor(mountedHeights.length / 2)
    ]
    expect(mountedHeights.length).toBeLessThanOrEqual(
      Math.ceil(viewportHeight / median) * 3
    )
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    requestFrame.mockRestore()
    owner.remove()
  }
})

it("throws when a mounted owner becomes zero-height during ResizeObserver geometry", () => {
  let height = 20
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    get: () => height,
  })
  document.body.appendChild(owner)
  ResizeObserverStub.observers = []
  const requestFrame = jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      scheduledFrame = callback
      return 1
    })
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ height: 20 } as DOMRect)
  let scheduledFrame: FrameRequestCallback | undefined

  render(
    <ResourceVirtualWindow
      entries={entries}
      scrollOwnerRef={{ current: owner }}
      renderEntry={(entry, onElement) => (
        <span ref={onElement}>
          {entry.kind === "resource" ? entry.resourceName : entry.kind}
        </span>
      )}
    />,
    { container: owner }
  )
  height = 0

  ResizeObserverStub.observers[0].callback([], {} as ResizeObserver)
  expect(() => scheduledFrame!(0)).toThrow(
    "Resource virtual window requires a positive owner height"
  )
  HTMLElement.prototype.getBoundingClientRect = originalRect
  requestFrame.mockRestore()
  owner.remove()
})

it("recomputes geometry on window resize without ResizeObserver and cleans up", () => {
  let height = 20
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    get: () => height,
  })
  document.body.appendChild(owner)
  const resizeObserver = Object.getOwnPropertyDescriptor(
    window,
    "ResizeObserver"
  )
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: undefined,
  })
  const frames: FrameRequestCallback[] = []
  const requestFrame = jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ height: 20 } as DOMRect)

  try {
    const view = render(
      <ResourceVirtualWindow
        entries={entries}
        scrollOwnerRef={{ current: owner }}
        renderEntry={(entry, onElement) => (
          <span ref={onElement} data-kind={entry.kind}>
            {entry.kind === "resource" ? entry.resourceName : entry.kind}
          </span>
        )}
      />,
      { container: owner }
    )
    for (let frame = 0; frame < 3; frame++)
      act(() => frames.splice(0).forEach((callback) => callback(frame)))
    const mountedBeforeResize = owner.querySelectorAll(
      '[data-kind="resource"]'
    ).length

    height = 60
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    act(() => frames.splice(0).forEach((callback) => callback(3)))

    const mountedAfterResize = owner.querySelectorAll(
      '[data-kind="resource"]'
    ).length
    expect(mountedAfterResize).toBeGreaterThan(mountedBeforeResize)
    expect(mountedAfterResize).toBeLessThanOrEqual(Math.ceil(height / 20) * 3)

    view.unmount()
    frames.splice(0)
    requestFrame.mockClear()
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    expect(requestFrame).not.toHaveBeenCalled()
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    requestFrame.mockRestore()
    if (resizeObserver)
      Object.defineProperty(window, "ResizeObserver", resizeObserver)
    else Reflect.deleteProperty(window, "ResizeObserver")
    owner.remove()
  }
})

it("keeps a target bounded after a width-only owner ResizeObserver event", async () => {
  let width = 320
  const owner = document.createElement("div")
  Object.defineProperties(owner, {
    clientHeight: { configurable: true, value: 20 },
    clientWidth: { configurable: true, get: () => width },
  })
  document.body.appendChild(owner)
  ResizeObserverStub.observers = []
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ height: 20 } as DOMRect)
  const mounted = jest.fn()

  try {
    render(
      <ResourceVirtualWindow
        entries={entries}
        scrollOwnerRef={{ current: owner }}
        targetKey="row:20"
        onTargetMounted={mounted}
        renderEntry={(entry, onElement) => (
          <span ref={onElement} data-kind={entry.kind}>
            {entry.kind === "resource" ? entry.resourceName : entry.kind}
          </span>
        )}
      />,
      { container: owner }
    )
    await waitFor(() => expect(mounted).toHaveBeenCalledTimes(1))
    const observer = ResizeObserverStub.observers[0]
    expect(observer.observed).toContain(owner)
    const mountedBeforeResize = owner.querySelectorAll('[data-kind="resource"]')
    expect(mountedBeforeResize.length).toBeLessThanOrEqual(3)
    expect(screen.getByText("row-20")).toBeInTheDocument()

    width = 80
    act(() => observer.callback([], {} as ResizeObserver))

    await waitFor(() =>
      expect(
        owner.querySelectorAll('[data-kind="resource"]').length
      ).toBeLessThanOrEqual(3)
    )
    expect(screen.getByText("row-20")).toBeInTheDocument()
    expect(mounted).toHaveBeenCalledTimes(1)
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    owner.remove()
  }
})

it("uses the pure structural offset before reporting a far target mounted", async () => {
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    value: 20,
  })
  document.body.appendChild(owner)
  const ownerRef = { current: owner }
  const onTargetMounted = jest.fn()
  const frames: FrameRequestCallback[] = []
  const requestFrame = jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
  const structuralEntries: ReadonlyArray<ResourceVirtualEntry<string>> = [
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
    ...entries.slice(0, 3),
  ]
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ height: 20 } as DOMRect)

  render(
    <ResourceVirtualWindow
      entries={structuralEntries}
      scrollOwnerRef={ownerRef}
      targetKey="row:2"
      onTargetMounted={onTargetMounted}
      renderEntry={(entry, onElement) => (
        <span ref={onElement}>
          {entry.kind === "resource" ? entry.resourceName : entry.kind}
        </span>
      )}
    />,
    { container: owner }
  )

  act(() => frames.splice(0).forEach((callback) => callback(0)))
  act(() => frames.splice(0).forEach((callback) => callback(1)))
  act(() => frames.splice(0).forEach((callback) => callback(2)))

  expect(owner.scrollTop).toBe(60)
  expect(onTargetMounted).toHaveBeenCalledWith("row:2", expect.any(HTMLElement))
  HTMLElement.prototype.getBoundingClientRect = originalRect
  requestFrame.mockRestore()
  owner.remove()
})

it("positions a target below fixed owner chrome before reporting it mounted", async () => {
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    value: 818,
  })
  document.body.appendChild(owner)
  const ownerRef = { current: owner }
  const onTargetMounted = jest.fn()
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === owner) return { top: 0, height: 818 } as DOMRect
    if (this.tagName === "UL")
      return {
        top: 130 - owner.scrollTop,
        height: 0,
      } as DOMRect
    return { height: 66 } as DOMRect
  }

  function SignedOriginHarness() {
    const contentOriginRef = React.useRef<HTMLUListElement>(null)
    return (
      <>
        <ul ref={contentOriginRef} />
        <ResourceVirtualWindow
          entries={entries}
          scrollOwnerRef={ownerRef}
          contentOriginRef={contentOriginRef}
          targetKey="row:11"
          onTargetMounted={onTargetMounted}
          renderEntry={(entry, onElement) => (
            <span ref={onElement}>
              {entry.kind === "resource" ? entry.resourceName : entry.kind}
            </span>
          )}
        />
      </>
    )
  }

  try {
    render(<SignedOriginHarness />, { container: owner })

    await waitFor(() => expect(onTargetMounted).toHaveBeenCalledTimes(1))
    expect(owner.scrollTop).toBe(104)
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    owner.remove()
  }
})

it("remeasures a position-only origin change before completing a near-fold target", async () => {
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    value: 818,
  })
  document.body.appendChild(owner)
  let scrollTop = 0
  const ownerTranslations: number[] = []
  Object.defineProperty(owner, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = next
      ownerTranslations.push(next)
    },
  })
  const ownerRef = { current: owner }
  const onTargetMounted = jest.fn()
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const frames: FrameRequestCallback[] = []
  const requestFrame = jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
  let originTop = 100
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === owner) return { top: 0, height: 818 } as DOMRect
    if (this.tagName === "UL")
      return {
        top: originTop - owner.scrollTop,
        height: 0,
      } as DOMRect
    return { height: 66 } as DOMRect
  }

  function PositionOnlyOriginHarness(props: {
    originVersion: number
    targetKey?: string
  }) {
    const contentOriginRef = React.useRef<HTMLUListElement>(null)
    return (
      <>
        <ul ref={contentOriginRef} />
        <ResourceVirtualWindow
          entries={entries}
          scrollOwnerRef={ownerRef}
          contentOriginRef={contentOriginRef}
          contentOriginVersion={props.originVersion}
          targetKey={props.targetKey}
          onTargetMounted={onTargetMounted}
          renderEntry={(entry, onElement) => (
            <span ref={onElement}>
              {entry.kind === "resource" ? entry.resourceName : entry.kind}
            </span>
          )}
        />
      </>
    )
  }

  try {
    const view = render(<PositionOnlyOriginHarness originVersion={0} />, {
      container: owner,
    })
    act(() => frames.splice(0).forEach((callback) => callback(0)))

    // Browser scroll anchoring preserves the signed list-local coordinate:
    // 0 - 100 and 30 - 130 are both -100. Only the measured origin changes.
    originTop = 130
    owner.scrollTop = 30
    view.rerender(
      <PositionOnlyOriginHarness originVersion={1} targetKey="row:11" />
    )

    await waitFor(() => expect(onTargetMounted).toHaveBeenCalledTimes(1))
    expect(owner.scrollTop).toBe(104)
    // A stale origin first translates to 74, then the geometry read repairs
    // it. Current geometry must make the sole virtual translation directly.
    expect(ownerTranslations).not.toContain(74)
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    requestFrame.mockRestore()
    owner.remove()
  }
})

it("retains the logical anchor across a position-only origin change", async () => {
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    value: 818,
  })
  document.body.appendChild(owner)
  const ownerRef = { current: owner }
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  let originTop = 100
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === owner) return { top: 0, height: 818 } as DOMRect
    if (this.tagName === "UL")
      return {
        top: originTop - owner.scrollTop,
        height: 0,
      } as DOMRect
    return { height: 66 } as DOMRect
  }

  function PositionOnlyAnchorHarness(props: { originVersion: number }) {
    const contentOriginRef = React.useRef<HTMLUListElement>(null)
    return (
      <>
        <ul ref={contentOriginRef} />
        <ResourceVirtualWindow
          entries={entries}
          scrollOwnerRef={ownerRef}
          contentOriginRef={contentOriginRef}
          contentOriginVersion={props.originVersion}
          renderEntry={(entry, onElement) => (
            <span ref={onElement}>
              {entry.kind === "resource" ? entry.resourceName : entry.kind}
            </span>
          )}
        />
      </>
    )
  }

  try {
    const view = render(<PositionOnlyAnchorHarness originVersion={0} />, {
      container: owner,
    })
    await waitFor(() => expect(screen.getByText("row-0")).toBeInTheDocument())

    originTop = 130
    owner.scrollTop = 30
    view.rerender(<PositionOnlyAnchorHarness originVersion={1} />)

    await waitFor(() => expect(owner.scrollTop).toBe(30))
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    owner.remove()
  }
})

it("completes a far-tail target after the browser clamps its scroll position", async () => {
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    value: 40,
  })
  document.body.appendChild(owner)
  const ownerRef = { current: owner }
  const onTargetMounted = jest.fn()
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ height: 20 } as DOMRect)

  render(
    <ResourceVirtualWindow
      entries={entries.slice(0, 3)}
      scrollOwnerRef={ownerRef}
      targetKey="row:2"
      onTargetMounted={onTargetMounted}
      renderEntry={(entry, onElement) => (
        <span ref={onElement}>
          {entry.kind === "resource" ? entry.resourceName : entry.kind}
        </span>
      )}
    />,
    { container: owner }
  )

  await waitFor(() => expect(onTargetMounted).toHaveBeenCalledTimes(1))
  expect(owner.scrollTop).toBe(20)
  HTMLElement.prototype.getBoundingClientRect = originalRect
  owner.remove()
})

it("adopts a settled target as the next anchor before allowing scroll or a repeated target", async () => {
  const owner = document.createElement("div")
  Object.defineProperty(owner, "clientHeight", {
    configurable: true,
    value: 40,
  })
  document.body.appendChild(owner)
  const ownerRef = { current: owner }
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ height: 10 } as DOMRect)
  const completions = jest.fn()
  const TargetJourney = () => {
    const [targetKey, setTargetKey] = React.useState<string | undefined>()
    return (
      <>
        <button onClick={() => setTargetKey("row:20")}>target</button>
        <ResourceVirtualWindow
          entries={entries}
          scrollOwnerRef={ownerRef}
          targetKey={targetKey}
          onTargetMounted={(key) => {
            completions(key)
            setTargetKey(undefined)
          }}
          renderSpacer={(height, position) => (
            <div data-spacer={position} style={{ height }} />
          )}
          renderEntry={(entry, onElement) => (
            <span
              ref={onElement}
              data-row={
                entry.kind === "resource" ? entry.resourceIndex : undefined
              }
            >
              {entry.kind === "resource" ? entry.resourceName : entry.kind}
            </span>
          )}
        />
      </>
    )
  }
  render(<TargetJourney />, { container: owner })

  owner.scrollTop = 100
  fireEvent.scroll(owner)
  await waitFor(() =>
    expect(owner.querySelector('[data-spacer="before"]')).toHaveStyle({
      height: "60px",
    })
  )
  fireEvent.click(screen.getByRole("button", { name: "target" }))
  await waitFor(() => expect(completions).toHaveBeenCalledTimes(1))
  expect(owner.scrollTop).toBe(170)

  owner.scrollTop = 240
  fireEvent.scroll(owner)
  await waitFor(() =>
    expect(owner.querySelector('[data-spacer="before"]')).toHaveStyle({
      height: "200px",
    })
  )
  fireEvent.click(screen.getByRole("button", { name: "target" }))
  await waitFor(() => expect(completions).toHaveBeenCalledTimes(2))
  expect(owner.scrollTop).toBe(200)
  HTMLElement.prototype.getBoundingClientRect = originalRect
  owner.remove()
})
