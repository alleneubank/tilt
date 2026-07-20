import React, { Component } from "react"
import { ResourceNav, useResourceNav } from "./ResourceNav"
import { isTargetEditable } from "./shortcut"
import SidebarItem from "./SidebarItem"
import { ResourceVirtualResourceEntry } from "./ResourceVirtualModel"
import { ResourceName, ResourceView } from "./types"

type Props = {
  items: ReadonlyArray<ResourceVirtualResourceEntry<SidebarItem>>
  selected: string
  resourceNav: ResourceNav
  resourceView: ResourceView
  onStartBuild: () => void
  onRequestOccurrence: (
    entry: ResourceVirtualResourceEntry<SidebarItem>,
    origin: OccurrenceCursorRequest["origin"]
  ) => void
  onRequestAll: () => void
  cursorRequest?: OccurrenceCursorRequest
}

/** A parent-owned navigation request for one exact logical occurrence. */
export type OccurrenceCursorRequest = Readonly<
  (
    | {
        kind: "aggregate"
        resourceName: ResourceName.all
      }
    | {
        kind: "occurrence"
        occurrenceKey: string
        resourceName: string
      }
  ) & {
    requestId: number
    origin: "keyboard" | "pointer"
    phase: "positioning" | "awaiting-route" | "settled"
  }
>

/**
 * Sets up keyboard shortcuts that depend on the state of the sidebar.
 */
class SidebarKeyboardShortcuts extends Component<Props> {
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
    if (isTargetEditable(e)) {
      return
    }

    if (e.shiftKey || e.altKey || e.isComposing) {
      return
    }

    let items = this.props.items
    let selected = this.props.selected || ResourceName.all
    switch (e.key) {
      case "j":
      case "k":
        // The cursor holds an occurrence identity, not a name. A resource can
        // occur beside itself under multiple labels, and name.indexOf loses it.
        const cursor = this.props.cursorRequest
        const selectedIndex = items.findIndex(
          (item) => item.resourceName === selected
        )
        // All is a real position before resource occurrences. Starred is an
        // external selection before that position, matching the original
        // names.indexOf behavior without pretending it is a virtual row.
        const index =
          cursor?.kind === "aggregate"
            ? 0
            : cursor?.kind === "occurrence"
            ? items.findIndex(
                (item) => item.occurrenceKey === cursor.occurrenceKey
              ) + 1
            : selected === ResourceName.all
            ? 0
            : selectedIndex < 0
            ? -1
            : selectedIndex + 1
        let dir = e.key === "j" ? 1 : -1
        let targetIndex = index + dir
        if (targetIndex < 0 || targetIndex > items.length) {
          return
        }
        if (targetIndex === 0) {
          this.props.onRequestAll()
          this.props.resourceNav.openResource(ResourceName.all)
          e.preventDefault()
          return
        }
        const target = items[targetIndex - 1]
        this.props.onRequestOccurrence(target, "keyboard")
        this.props.resourceNav.openResource(target.resourceName)
        e.preventDefault()
        break

      case "r":
        if (e.metaKey || e.ctrlKey) {
          return
        }
        this.props.onStartBuild()
        e.preventDefault()
        break
    }
  }

  render() {
    return <span></span>
  }
}

type PublicProps = {
  items: ReadonlyArray<ResourceVirtualResourceEntry<SidebarItem>>
  selected: string
  onStartBuild: () => void
  resourceView: ResourceView
  onRequestOccurrence: (
    entry: ResourceVirtualResourceEntry<SidebarItem>,
    origin: OccurrenceCursorRequest["origin"]
  ) => void
  onRequestAll: () => void
  cursorRequest?: OccurrenceCursorRequest
}

export default function (props: PublicProps) {
  let resourceNav = useResourceNav()
  return <SidebarKeyboardShortcuts {...props} resourceNav={resourceNav} />
}
