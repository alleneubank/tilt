import { fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { Row } from "react-table"
import {
  OverviewOccurrenceCursor,
  OverviewTableKeyboardShortcuts,
  reconcileOverviewOccurrence,
} from "./OverviewTableKeyboardShortcuts"
import { RowValues } from "./OverviewTableColumns"
import { ResourceVirtualResourceEntry } from "./ResourceVirtualModel"
import {
  ResourceSelectionProvider,
  useResourceSelection,
} from "./ResourceSelectionContext"

function entry(
  name: string,
  index: number
): ResourceVirtualResourceEntry<Row<RowValues>> {
  return {
    kind: "resource",
    occurrenceKey: `label:${index}:${name}`,
    resourceName: name,
    groupId: `label:${index}`,
    item: { original: { name, selectable: true } } as Row<RowValues>,
    resourceIndex: index,
    groupIndex: index,
    layoutKey: "overview-resource-row",
  }
}

const entries = [entry("duplicate", 0), entry("duplicate", 1), entry("tail", 2)]

function SelectionProbe() {
  const selection = useResourceSelection()
  return <output>{String(selection.isSelected("duplicate"))}</output>
}

function renderShortcuts(
  cursor: OverviewOccurrenceCursor | undefined,
  onRequestOccurrence = jest.fn()
) {
  const view = render(
    <ResourceSelectionProvider>
      <OverviewTableKeyboardShortcuts
        items={entries}
        cursor={cursor}
        onRequestOccurrence={onRequestOccurrence}
      />
      <SelectionProbe />
    </ResourceSelectionProvider>
  )
  return { ...view, onRequestOccurrence }
}

it("traverses exact logical occurrences while the target is not mounted", () => {
  const first = renderShortcuts(undefined)
  fireEvent.keyDown(document.body, { key: "j" })
  expect(first.onRequestOccurrence).toHaveBeenLastCalledWith(entries[0])

  first.rerender(
    <ResourceSelectionProvider>
      <OverviewTableKeyboardShortcuts
        items={entries}
        cursor={{
          occurrenceKey: entries[0].occurrenceKey,
          resourceName: "duplicate",
        }}
        onRequestOccurrence={first.onRequestOccurrence}
      />
      <SelectionProbe />
    </ResourceSelectionProvider>
  )
  fireEvent.keyDown(document.body, { key: "ArrowDown" })
  expect(first.onRequestOccurrence).toHaveBeenLastCalledWith(entries[1])
  first.rerender(
    <ResourceSelectionProvider>
      <OverviewTableKeyboardShortcuts
        items={entries}
        cursor={{
          occurrenceKey: entries[1].occurrenceKey,
          resourceName: "duplicate",
        }}
        onRequestOccurrence={first.onRequestOccurrence}
      />
      <SelectionProbe />
    </ResourceSelectionProvider>
  )
  fireEvent.keyDown(document.body, { key: "ArrowUp" })
  expect(first.onRequestOccurrence).toHaveBeenLastCalledWith(entries[0])
})

it.each(["k", "Up", "j", "Down"])(
  "starts %s at the first logical occurrence when there is no cursor",
  (key) => {
    const { onRequestOccurrence, unmount } = renderShortcuts(undefined)

    fireEvent.keyDown(document.body, { key })

    expect(onRequestOccurrence).toHaveBeenCalledWith(entries[0])
    unmount()
  }
)

it("selects the exact cursor resource and leaves editable targets alone", () => {
  const view = renderShortcuts({
    occurrenceKey: entries[1].occurrenceKey,
    resourceName: "duplicate",
  })
  fireEvent.keyDown(document.body, { key: "x" })
  expect(screen.getByRole("status")).toHaveTextContent("true")

  const input = document.createElement("input")
  document.body.appendChild(input)
  input.focus()
  fireEvent.keyDown(input, { key: "j" })
  expect(view.onRequestOccurrence).not.toHaveBeenCalled()
  input.remove()
})

it("reconciles a filtered occurrence by resource name before keyboard traversal", () => {
  const filtered = [
    {
      ...entries[1],
      occurrenceKey: "ungrouped:duplicate",
      groupId: "ungrouped",
    },
    {
      ...entries[2],
      occurrenceKey: "ungrouped:tail",
      groupId: "ungrouped",
    },
  ]
  const stale = {
    occurrenceKey: entries[1].occurrenceKey,
    resourceName: "duplicate",
  }

  expect(reconcileOverviewOccurrence(filtered, stale)).toEqual({
    occurrenceKey: "ungrouped:duplicate",
    resourceName: "duplicate",
  })
  expect(reconcileOverviewOccurrence(filtered, undefined)).toBeUndefined()
  expect(
    reconcileOverviewOccurrence(filtered, {
      occurrenceKey: "label:missing",
      resourceName: "missing",
    })
  ).toBeUndefined()
})
