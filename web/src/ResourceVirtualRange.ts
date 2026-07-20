import { ResourceVirtualEntry } from "./ResourceVirtualModel"

export const RESOURCE_VIRTUAL_OVERSCAN_VIEWPORTS = 1
export const RESOURCE_VIRTUAL_BOOTSTRAP_SIZE = 1

export type ResourceVirtualRangeInput = Readonly<{
  viewportHeight: number
  scrollTop: number
  /**
   * The earliest browser-achievable list-local viewport start. A sequence
   * below static owner chrome begins at a negative local offset until that
   * chrome has scrolled away.
   */
  minimumScrollTop?: number
  /** Real geometry for every resource layout class in the logical sequence. */
  resourceHeights: ReadonlyMap<string, number>
  /** Real geometry for every structural layout class in the logical sequence. */
  structuralHeights: ReadonlyMap<string, number>
  targetKey?: string
  retainedAnchor?: Readonly<{
    occurrenceKey: string
    resourceIndex: number
    offset: number
  }>
  entryHeights?: ReadonlyMap<string, number>
}>

export type ResourceVirtualRange<T> = Readonly<{
  start: number
  end: number
  entries: ReadonlyArray<ResourceVirtualEntry<T>>
  beforeSpacer: number
  afterSpacer: number
  resourceCapacity: number
  resourceBound: number
  totalHeight: number
  anchorAdjustment: number
  visibleResource?: Readonly<{
    occurrenceKey: string
    resourceIndex: number
    offset: number
  }>
  /** The list-local position used to calculate this range. */
  scrollTop: number
}>

function assertPositive(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be finite and positive`)
}
export function resourceVirtualEntryKey<T>(entry: ResourceVirtualEntry<T>) {
  if (entry.kind === "resource") return entry.occurrenceKey
  if (entry.kind === "group-header") return `group:${entry.groupId}`
  return `disabled:${entry.sectionId}`
}

export function resourceVirtualEntryLayoutKey<T>(
  entry: ResourceVirtualEntry<T>
) {
  if (!entry.layoutKey.trim())
    throw new Error(
      `Virtual entry ${resourceVirtualEntryKey(
        entry
      )} requires a non-empty layout key`
    )
  return entry.layoutKey
}

/**
 * Logical occurrences identify navigation; their current layout identifies
 * geometry. Keeping both in this cache key makes a projection change discard
 * only the now-inapplicable exact rectangle, not all useful measurements.
 */
export function resourceVirtualMeasurementKey<T>(
  entry: ResourceVirtualEntry<T>
) {
  return `${resourceVirtualEntryKey(entry)}::${resourceVirtualEntryLayoutKey(
    entry
  )}`
}

function entryHeight<T>(
  entry: ResourceVirtualEntry<T>,
  resourceHeights: ReadonlyMap<string, number>,
  structuralHeights: ReadonlyMap<string, number>,
  entryHeights?: ReadonlyMap<string, number>
) {
  const measured = entryHeights?.get(resourceVirtualMeasurementKey(entry))
  if (measured !== undefined) return measured
  const layoutKey = resourceVirtualEntryLayoutKey(entry)
  if (entry.kind === "resource") return resourceHeights.get(layoutKey)!
  return structuralHeights.get(layoutKey)!
}

function resourceLayoutKeys<T>(
  entries: ReadonlyArray<ResourceVirtualEntry<T>>
) {
  return new Set(
    entries
      .filter(
        (entry): entry is ResourceVirtualEntry<T> & { kind: "resource" } =>
          entry.kind === "resource"
      )
      .map(resourceVirtualEntryLayoutKey)
  )
}

function structuralLayoutKeys<T>(
  entries: ReadonlyArray<ResourceVirtualEntry<T>>
) {
  return new Set(
    entries
      .filter((entry) => entry.kind !== "resource")
      .map(resourceVirtualEntryLayoutKey)
  )
}

export function computeResourceVirtualRange<T>(
  entries: ReadonlyArray<ResourceVirtualEntry<T>>,
  input: ResourceVirtualRangeInput
): ResourceVirtualRange<T> {
  assertPositive(input.viewportHeight, "viewportHeight")
  input.resourceHeights.forEach((height, key) =>
    assertPositive(height, `resource measurement for ${key}`)
  )
  const layouts = resourceLayoutKeys(entries)
  layouts.forEach((layoutKey) => {
    if (!input.resourceHeights.has(layoutKey))
      throw new Error(`Missing resource measurement for layout ${layoutKey}`)
  })
  const structuralHeights = input.structuralHeights
  structuralHeights.forEach((height, key) =>
    assertPositive(height, `structural measurement for ${key}`)
  )
  structuralLayoutKeys(entries).forEach((layoutKey) => {
    if (!structuralHeights.has(layoutKey))
      throw new Error(`Missing structural measurement for layout ${layoutKey}`)
  })
  input.entryHeights?.forEach((height, key) =>
    assertPositive(height, `measurement for ${key}`)
  )
  const minimumScrollTop = input.minimumScrollTop ?? 0
  if (!Number.isFinite(minimumScrollTop))
    throw new Error("minimumScrollTop must be finite")
  if (!Number.isFinite(input.scrollTop) || input.scrollTop < minimumScrollTop)
    throw new Error(
      "scrollTop must be finite and no less than minimumScrollTop"
    )
  const offsets: number[] = []
  const heights: number[] = []
  let totalHeight = 0
  const seen = new Set<string>()
  entries.forEach((entry) => {
    offsets.push(totalHeight)
    if (entry.kind === "resource") {
      if (seen.has(entry.occurrenceKey))
        throw new Error(
          `Duplicate resource occurrence key: ${entry.occurrenceKey}`
        )
      seen.add(entry.occurrenceKey)
    }
    const height = entryHeight(
      entry,
      input.resourceHeights,
      structuralHeights,
      input.entryHeights
    )
    assertPositive(
      height,
      `entry measurement for ${resourceVirtualEntryKey(entry)}`
    )
    heights.push(height)
    totalHeight += height
  })
  // Before the owner reaches the virtual sequence, browser scroll zero maps
  // to a signed local start. A short sequence therefore has one achievable
  // viewport, at this minimum, rather than an impossible list-local zero.
  const maximumScrollTop = Math.max(
    minimumScrollTop,
    totalHeight - input.viewportHeight
  )
  let anchorOffset = Math.min(input.scrollTop, maximumScrollTop)
  if (input.targetKey) {
    const targetIndex = entries.findIndex(
      (entry) =>
        entry.kind === "resource" && entry.occurrenceKey === input.targetKey
    )
    if (targetIndex < 0)
      throw new Error(`Virtual target not found: ${input.targetKey}`)
    const targetTop = offsets[targetIndex]
    const targetBottom = targetTop + heights[targetIndex]
    // Match scrollIntoView({ block: "nearest" }) against logical geometry.
    // A target taller than its viewport deterministically exposes its leading edge.
    if (
      heights[targetIndex] >= input.viewportHeight ||
      targetTop < anchorOffset
    )
      anchorOffset = targetTop
    else if (targetBottom > anchorOffset + input.viewportHeight)
      anchorOffset = targetBottom - input.viewportHeight
    anchorOffset = Math.min(
      maximumScrollTop,
      Math.max(minimumScrollTop, anchorOffset)
    )
  } else if (input.retainedAnchor) {
    const anchorIndex = entries.findIndex(
      (entry) =>
        entry.kind === "resource" &&
        entry.occurrenceKey === input.retainedAnchor!.occurrenceKey
    )
    const fallbackIndex = entries.reduce((closest, entry, index) => {
      if (entry.kind !== "resource") return closest
      if (closest < 0) return index
      const closestEntry = entries[closest]
      const closestDistance =
        closestEntry.kind === "resource"
          ? Math.abs(
              closestEntry.resourceIndex - input.retainedAnchor!.resourceIndex
            )
          : Infinity
      return Math.abs(
        entry.resourceIndex - input.retainedAnchor!.resourceIndex
      ) < closestDistance
        ? index
        : closest
    }, -1)
    const resolvedIndex = anchorIndex >= 0 ? anchorIndex : fallbackIndex
    if (resolvedIndex >= 0)
      anchorOffset = Math.min(
        maximumScrollTop,
        Math.max(
          minimumScrollTop,
          offsets[resolvedIndex] - input.retainedAnchor.offset
        )
      )
  }
  const lower = Math.max(
    0,
    anchorOffset - input.viewportHeight * RESOURCE_VIRTUAL_OVERSCAN_VIEWPORTS
  )
  const upper =
    anchorOffset +
    input.viewportHeight * (1 + RESOURCE_VIRTUAL_OVERSCAN_VIEWPORTS)
  const visibleBottom = Math.min(
    totalHeight,
    anchorOffset + input.viewportHeight
  )
  let start = entries.findIndex(
    (_, index) => offsets[index] + heights[index] > anchorOffset
  )
  if (start < 0) start = entries.length
  let end = start
  while (end < entries.length && offsets[end] < visibleBottom) end++

  const resourceMetrics = (sliceStart: number, sliceEnd: number) => {
    const resourceHeights = entries.reduce<number[]>((result, entry, index) => {
      if (index >= sliceStart && index < sliceEnd && entry.kind === "resource")
        result.push(heights[index])
      return result
    }, [])
    if (!resourceHeights.length)
      return { capacity: 0, bound: 0, count: 0, median: 0 }
    resourceHeights.sort((left, right) => left - right)
    const median = resourceHeights[Math.floor(resourceHeights.length / 2)]
    const capacity = Math.ceil(input.viewportHeight / median)
    return {
      capacity,
      bound: capacity * (1 + RESOURCE_VIRTUAL_OVERSCAN_VIEWPORTS * 2),
      count: resourceHeights.length,
      median,
    }
  }
  const visibleMetrics = resourceMetrics(start, end)
  if (visibleMetrics.count > visibleMetrics.bound)
    throw new Error(
      `Visible resource interval requires ${visibleMetrics.count} resources but permits ${visibleMetrics.bound} at median ${visibleMetrics.median}`
    )
  // Never trim visible work. Extend only through one viewport of overscan when
  // the final slice's own median-derived bound still permits the addition.
  while (
    start > 0 &&
    offsets[start - 1] + heights[start - 1] > lower &&
    resourceMetrics(start - 1, end).count <=
      resourceMetrics(start - 1, end).bound
  )
    start--
  while (
    end < entries.length &&
    offsets[end] < upper &&
    resourceMetrics(start, end + 1).count <=
      resourceMetrics(start, end + 1).bound
  )
    end++
  const rendered = entries.slice(start, end)
  const {
    capacity: resourceCapacity,
    bound: resourceBound,
    count: resourceCount,
  } = resourceMetrics(start, end)
  if (resourceCount > resourceBound)
    throw new Error("Virtual resource bound is impossible")
  const beforeSpacer = offsets[start] ?? 0
  const renderedHeight = heights
    .slice(start, end)
    .reduce((sum, height) => sum + height, 0)
  // An ordinary anchor is only useful if it is both geometrically visible and
  // part of the selected slice. A logical resource below structural rows can
  // otherwise retain scroll even though it has no mounted element.
  const visibleIndex = entries.findIndex(
    (entry, index) =>
      index >= start &&
      index < end &&
      entry.kind === "resource" &&
      offsets[index] < visibleBottom &&
      offsets[index] + heights[index] > anchorOffset
  )
  const visibleEntry = entries[visibleIndex]
  return {
    start,
    end,
    entries: rendered,
    beforeSpacer,
    afterSpacer: Math.max(0, totalHeight - beforeSpacer - renderedHeight),
    resourceCapacity,
    resourceBound,
    totalHeight,
    anchorAdjustment: anchorOffset - input.scrollTop,
    scrollTop: input.scrollTop,
    visibleResource:
      visibleEntry?.kind === "resource"
        ? {
            occurrenceKey: visibleEntry.occurrenceKey,
            resourceIndex: visibleEntry.resourceIndex,
            offset: offsets[visibleIndex] - anchorOffset,
          }
        : undefined,
  }
}
