import React, { Component } from "react"
import { ResourceVirtualResourceEntry } from "./ResourceVirtualModel"
import { RowValues } from "./OverviewTableColumns"
import {
  ResourceSelectionContext,
  useResourceSelection,
} from "./ResourceSelectionContext"
import { isTargetEditable } from "./shortcut"
import { Row } from "react-table"

export type OverviewOccurrenceCursor = Readonly<{
  occurrenceKey: string
  resourceName: string
}>

/**
 * A filter can legitimately replace a label-qualified occurrence with its
 * ungrouped identity. Keep an exact duplicate occurrence when it survives;
 * otherwise use the first remaining occurrence for the same resource.
 */
export function reconcileOverviewOccurrence(
  items: ReadonlyArray<ResourceVirtualResourceEntry<Row<RowValues>>>,
  cursor: OverviewOccurrenceCursor | undefined
): OverviewOccurrenceCursor | undefined {
  if (!cursor) return undefined
  const exact = items.find(
    (entry) => entry.occurrenceKey === cursor.occurrenceKey
  )
  const surviving =
    exact ?? items.find((entry) => entry.resourceName === cursor.resourceName)
  return surviving
    ? {
        occurrenceKey: surviving.occurrenceKey,
        resourceName: surviving.resourceName,
      }
    : undefined
}

type Props = {
  items: ReadonlyArray<ResourceVirtualResourceEntry<Row<RowValues>>>
  cursor?: OverviewOccurrenceCursor
  onRequestOccurrence: (
    entry: ResourceVirtualResourceEntry<Row<RowValues>>
  ) => void
  selection: ResourceSelectionContext
}

/** Keyboard navigation is driven by the complete logical occurrence stream. */
class Shortcuts extends Component<Props> {
  constructor(props: Props) {
    super(props)
    this.onKeydown = this.onKeydown.bind(this)
  }

  componentDidMount() {
    document.body.addEventListener("keydown", this.onKeydown)
  }

  componentWillUnmount() {
    document.body.removeEventListener("keydown", this.onKeydown)
  }

  onKeydown(e: KeyboardEvent) {
    if (isTargetEditable(e) || e.shiftKey || e.altKey || e.isComposing) return

    const items = this.props.items
    const cursor = reconcileOverviewOccurrence(items, this.props.cursor)
    if (e.key === "x") {
      if (e.metaKey || e.ctrlKey || !cursor) return
      const item = items.find(
        (entry) => entry.occurrenceKey === cursor.occurrenceKey
      )
      if (!item || !item.item.original.selectable) return
      if (this.props.selection.isSelected(item.resourceName))
        this.props.selection.deselect(item.resourceName)
      else this.props.selection.select(item.resourceName)
      e.preventDefault()
      return
    }

    const direction =
      e.key === "j" || e.key === "ArrowDown" || e.key === "Down"
        ? 1
        : e.key === "k" || e.key === "ArrowUp" || e.key === "Up"
        ? -1
        : 0
    if (!direction) return

    // Before the first navigation request, legacy table behavior always
    // entered the logical stream at its first occurrence, independent of the
    // shortcut's direction. Once an occurrence is established, directions
    // return to ordinary adjacent traversal.
    const currentIndex = cursor
      ? items.findIndex((entry) => entry.occurrenceKey === cursor.occurrenceKey)
      : -1
    const target = cursor ? items[currentIndex + direction] : items[0]
    if (!target) return
    this.props.onRequestOccurrence(target)
    e.preventDefault()
  }

  render() {
    return null
  }
}

type PublicProps = Omit<Props, "selection">

export function OverviewTableKeyboardShortcuts(props: PublicProps) {
  return <Shortcuts {...props} selection={useResourceSelection()} />
}
