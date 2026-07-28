/** A logical item is independent of whether it is currently mounted in the DOM. */
export type ResourceVirtualResourceEntry<T> = Readonly<{
  kind: "resource"
  occurrenceKey: string
  resourceName: string
  groupId: string
  item: T
  resourceIndex: number
  groupIndex: number
  /** The DOM layout class whose measured geometry calibrates this resource. */
  layoutKey: string
  /** Whether this row owns the logical separation from an earlier peer. */
  flow?: "leading" | "continuation"
  /** Sidebar semantic ownership remains available when its structural row is off-window. */
  section?: "enabled" | "disabled"
}>

export type ResourceVirtualGroupHeaderEntry<T> = Readonly<{
  kind: "group-header"
  groupId: string
  label: string
  expanded: boolean
  members: ReadonlyArray<T>
  memberCount: number
  /** Tiltfile is a fixed section heading; every other grouped header toggles. */
  collapsible: boolean
  /** The DOM layout class whose measured geometry calibrates this header. */
  layoutKey: string
}>

export type ResourceVirtualDisabledHeaderEntry = Readonly<{
  kind: "disabled-header"
  sectionId: string
  groupId: string
  memberCount: number
  /** The DOM layout class whose measured geometry calibrates this header. */
  layoutKey: string
}>

export type ResourceVirtualEntry<T> =
  | ResourceVirtualResourceEntry<T>
  | ResourceVirtualGroupHeaderEntry<T>
  | ResourceVirtualDisabledHeaderEntry

export type ResourceVirtualGroup<T> = Readonly<{
  id: string
  label: string
  members: ReadonlyArray<T>
  expanded: boolean
}>

export type SidebarVirtualModel<T> = Readonly<{
  entries: ReadonlyArray<ResourceVirtualEntry<T>>
  /** Includes collapsed members: this is the source of truth for keyboard traversal. */
  logicalResources: ReadonlyArray<ResourceVirtualResourceEntry<T>>
  groups: ReadonlyMap<string, ResourceVirtualGroup<T>>
}>

export type SidebarVirtualModelInput<T> = Readonly<{
  items: ReadonlyArray<T>
  isDisabled: (item: T) => boolean
  isTiltfile: (item: T) => boolean
  groupState: Readonly<Record<string, boolean>>
  selectedName?: string
  labelsForItem?: (item: T) => ReadonlyArray<string>
  nameForItem?: (item: T) => string
  layoutKeyForItem?: (
    item: T,
    section: "enabled" | "disabled",
    flow: "leading" | "continuation"
  ) => string
  sortLabels?: (labels: string[]) => string[]
  grouped?: boolean
  /** Sidebar keeps its historic enabled/disabled subsections; overview does not. */
  partitionDisabled?: boolean
  /** A selected sidebar resource expands its group; overview navigation does so explicitly. */
  expandSelectedGroup?: boolean
  /** Surface policy for which grouped headers expose accordion behavior. */
  groupCollapsible?: (group: ResourceVirtualGroup<T>) => boolean
  /** Surface-owned structural geometry for expanded and collapsed group headers. */
  groupHeaderLayoutKey?: (
    group: ResourceVirtualGroup<T>,
    expanded: boolean,
    collapsible: boolean
  ) => string
}>

type GroupBucket<T> = { id: string; label: string; members: T[] }

const defaultName = <T extends { name: string }>(item: T) => item.name
const defaultLabels = <T extends { labels: string[] }>(item: T) => item.labels

function assertName(name: string) {
  if (!name.trim()) {
    throw new Error("Resource virtual model requires a non-empty resource name")
  }
}

function structuralLayoutKey(groupId: string, collapsible: boolean) {
  if (groupId === "tiltfile") return "tiltfile-header"
  return collapsible ? "group-header" : "disabled-header"
}

function addOccurrence<T>(
  result: ResourceVirtualResourceEntry<T>[],
  seen: Set<string>,
  item: T,
  name: string,
  groupId: string,
  resourceIndex: number,
  groupIndex: number,
  layoutKey: string,
  section: "enabled" | "disabled",
  flow: "leading" | "continuation"
) {
  const occurrenceKey = `${groupId}:${name}`
  if (!layoutKey.trim())
    throw new Error(`Resource virtual model requires a layout key for ${name}`)
  if (seen.has(occurrenceKey)) {
    throw new Error(`Duplicate resource occurrence key: ${occurrenceKey}`)
  }
  seen.add(occurrenceKey)
  result.push({
    kind: "resource",
    occurrenceKey,
    resourceName: name,
    groupId,
    item,
    resourceIndex,
    groupIndex,
    layoutKey,
    section,
    flow,
  })
}

/**
 * Builds sidebar projection after filtering/sorting have already happened. It deliberately
 * stores all group members even where a collapsed group hides its occurrences from `entries`.
 */
export function buildSidebarVirtualModel<T>(
  input: SidebarVirtualModelInput<T>
): SidebarVirtualModel<T> {
  const nameForItem = input.nameForItem ?? (defaultName as (item: T) => string)
  const labelsForItem =
    input.labelsForItem ?? (defaultLabels as (item: T) => string[])
  const grouped = input.grouped ?? true
  const partitionDisabled = input.partitionDisabled ?? true
  const expandSelectedGroup = input.expandSelectedGroup ?? true
  const layoutKeyForItem = input.layoutKeyForItem ?? (() => "default")
  const buckets = new Map<string, GroupBucket<T>>()
  const ungrouped: T[] = []
  const tiltfile: T[] = []

  input.items.forEach((item) => {
    const name = nameForItem(item)
    assertName(name)
    const labels = labelsForItem(item)
    if (grouped && labels.length) {
      labels.forEach((label) => {
        if (!label.trim())
          throw new Error(`Invalid empty group label for ${name}`)
        const id = `label:${label}`
        const bucket = buckets.get(id) ?? { id, label, members: [] }
        bucket.members.push(item)
        buckets.set(id, bucket)
      })
    } else if (grouped && input.isTiltfile(item)) {
      tiltfile.push(item)
    } else {
      ungrouped.push(item)
    }
  })

  const orderedBuckets = Array.from(buckets.values())
  const labels = orderedBuckets.map((bucket) => bucket.label)
  const sortedLabels = input.sortLabels
    ? input.sortLabels(labels)
    : labels.sort()
  if (
    sortedLabels.length !== labels.length ||
    new Set(sortedLabels).size !== labels.length ||
    sortedLabels.some((label) => !buckets.has(`label:${label}`))
  ) {
    throw new Error("Label sorter must return an exact group permutation")
  }
  const orderedGroups: GroupBucket<T>[] = sortedLabels.map((label) => {
    const group = buckets.get(`label:${label}`)
    if (!group)
      throw new Error(`Inconsistent group identity for label: ${label}`)
    return group
  })
  if (ungrouped.length)
    orderedGroups.push({
      id: "ungrouped",
      label: "unlabeled",
      members: ungrouped,
    })
  if (tiltfile.length)
    orderedGroups.push({ id: "tiltfile", label: "Tiltfile", members: tiltfile })

  const entries: ResourceVirtualEntry<T>[] = []
  const logicalResources: ResourceVirtualResourceEntry<T>[] = []
  const groups = new Map<string, ResourceVirtualGroup<T>>()
  const seen = new Set<string>()
  let resourceIndex = 0

  orderedGroups.forEach((group) => {
    const selectedInGroup = group.members.some(
      (item) => nameForItem(item) === input.selectedName
    )
    const defaultCollapsible = grouped && group.id !== "tiltfile"
    const preliminaryGroup = {
      id: group.id,
      label: group.label,
      members: Object.freeze([...group.members]),
      expanded: false,
    }
    const collapsible = input.groupCollapsible
      ? grouped && input.groupCollapsible(preliminaryGroup)
      : defaultCollapsible
    const expanded =
      !collapsible ||
      (input.groupState[group.label] ?? true) ||
      (expandSelectedGroup && selectedInGroup)
    const groupRecord = {
      ...preliminaryGroup,
      expanded,
    }
    groups.set(group.id, groupRecord)
    if (grouped) {
      entries.push({
        kind: "group-header",
        groupId: group.id,
        label: group.label,
        expanded,
        members: groupRecord.members,
        memberCount: group.members.length,
        collapsible,
        layoutKey:
          input.groupHeaderLayoutKey?.(groupRecord, expanded, collapsible) ??
          structuralLayoutKey(group.id, collapsible),
      })
    }
    const enabled = partitionDisabled
      ? group.members.filter((item) => !input.isDisabled(item))
      : group.members
    const disabled = partitionDisabled
      ? group.members.filter((item) => input.isDisabled(item))
      : []
    const addMembers = (
      items: T[],
      groupIndexOffset: number,
      section: "enabled" | "disabled"
    ) =>
      items.forEach((item, itemIndex) => {
        const occurrence: ResourceVirtualResourceEntry<T>[] = []
        addOccurrence(
          occurrence,
          seen,
          item,
          nameForItem(item),
          group.id,
          resourceIndex++,
          groupIndexOffset + itemIndex,
          layoutKeyForItem(
            item,
            section,
            itemIndex === 0 ? "leading" : "continuation"
          ),
          section,
          itemIndex === 0 ? "leading" : "continuation"
        )
        logicalResources.push(occurrence[0])
        if (expanded || !grouped) entries.push(occurrence[0])
      })
    addMembers(enabled, 0, "enabled")
    if (disabled.length && (expanded || !grouped)) {
      entries.push({
        kind: "disabled-header",
        sectionId: `disabled:${group.id}`,
        groupId: group.id,
        memberCount: disabled.length,
        layoutKey: "disabled-header",
      })
    }
    // Disabled occurrences remain in the keyboard model even while this
    // group's collapsed DOM omits both its disabled heading and rows.
    addMembers(disabled, enabled.length, "disabled")
  })

  return {
    entries: Object.freeze(entries),
    logicalResources: Object.freeze(logicalResources),
    groups,
  }
}

export function resourceEntriesInOrder<T>(
  entries: ReadonlyArray<ResourceVirtualEntry<T>>
) {
  return entries.filter(
    (entry): entry is ResourceVirtualResourceEntry<T> =>
      entry.kind === "resource"
  )
}

export function findResourceOccurrence<T>(
  entries: ReadonlyArray<ResourceVirtualResourceEntry<T>>,
  resourceName: string
): ResourceVirtualResourceEntry<T> | undefined {
  return entries.find((entry) => entry.resourceName === resourceName)
}
