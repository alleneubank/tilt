import React, {
  ReactNode,
  RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { ResourceVirtualEntry } from "./ResourceVirtualModel"
import {
  computeResourceVirtualRange,
  resourceVirtualEntryKey,
  resourceVirtualEntryLayoutKey,
  resourceVirtualMeasurementKey,
} from "./ResourceVirtualRange"

type ContentOriginVersion = string | number | boolean

export type ResourceVirtualWindowProps<T> = Readonly<{
  entries: ReadonlyArray<ResourceVirtualEntry<T>>
  /** The caller owns list/table semantics, so the window never adds row wrappers. */
  renderEntry: (
    entry: ResourceVirtualEntry<T>,
    onElement: (element: HTMLElement | null) => void
  ) => ReactNode
  /** Composes the globally selected slice into caller-owned semantic chunks. */
  renderEntries?: (
    entries: ReadonlyArray<ResourceVirtualEntry<T>>,
    renderEntry: (
      entry: ResourceVirtualEntry<T>,
      onElement: (element: HTMLElement | null) => void
    ) => ReactNode
  ) => ReactNode
  renderSpacer?: (height: number, position: "before" | "after") => ReactNode
  /** Use a fragment when entries are direct children of a semantic list/table. */
  asFragment?: boolean
  scrollOwnerRef?: RefObject<HTMLElement>
  /** The first list element after controls that share the scroll owner. */
  contentOriginRef?: RefObject<HTMLElement>
  /** Invalidates position-only chrome changes above the content origin. */
  contentOriginVersion?: ContentOriginVersion
  targetKey?: string
  onTargetMounted?: (key: string, element: HTMLElement) => void
  onMounted?: (entry: ResourceVirtualEntry<T>, element: HTMLElement) => void
}>

/** Renders a bounded logical slice; its parent scrollport supplies real browser geometry. */
export function ResourceVirtualWindow<T>(props: ResourceVirtualWindowProps<T>) {
  const ownRef = useRef<HTMLDivElement>(null)
  const owner = () =>
    props.scrollOwnerRef?.current ?? ownRef.current?.parentElement ?? null
  const [geometry, setGeometry] = useState<{
    viewportHeight: number
    scrollTop: number
    contentOrigin: number
    contentOriginVersion: ContentOriginVersion | undefined
    measurementVersion: number
  } | null>(null)
  const measuredResourceHeights = useRef(new Map<string, number>())
  const measuredStructuralHeights = useRef(new Map<string, number>())
  const entryHeights = useRef(new Map<string, number>())
  const mounted = useRef(new Map<string, HTMLElement>())
  const completedTarget = useRef<string | null>(null)
  const activeTarget = useRef<string | undefined>(undefined)
  const retainedAnchor = useRef<{
    occurrenceKey: string
    resourceIndex: number
    offset: number
  } | null>(null)
  const frame = useRef<number | null>(null)
  const measurementsDirty = useRef(false)
  const measurementVersion = useRef(0)
  // The version is caller-owned because only the semantic owner knows which
  // chrome transitions can move the list without resizing either observed box.
  const geometryIsStale =
    geometry !== null &&
    geometry.contentOriginVersion !== props.contentOriginVersion
  const rangeTargetKey = geometryIsStale ? undefined : props.targetKey
  const resourceLayouts = useMemo(
    () =>
      new Set(
        props.entries
          .filter(
            (entry): entry is ResourceVirtualEntry<T> & { kind: "resource" } =>
              entry.kind === "resource"
          )
          .map(resourceVirtualEntryLayoutKey)
      ),
    [props.entries]
  )
  const calibrationEntry = useMemo(() => {
    const selected = rangeTargetKey
      ? props.entries.find(
          (entry) =>
            entry.kind === "resource" && entry.occurrenceKey === rangeTargetKey
        )
      : undefined
    // Bootstrap is deliberately a handshake, never a representative batch:
    // before capacity is known, one contiguous logical entry is the only
    // globally safe resource slice. A requested target wins when its current
    // layout is missing; remaining classes follow immutable sequence order.
    if (
      selected &&
      !measuredResourceHeights.current.has(
        resourceVirtualEntryLayoutKey(selected)
      )
    )
      return selected
    return props.entries.find((entry) =>
      entry.kind === "resource"
        ? !measuredResourceHeights.current.has(
            resourceVirtualEntryLayoutKey(entry)
          )
        : !measuredStructuralHeights.current.has(
            resourceVirtualEntryLayoutKey(entry)
          )
    )
  }, [
    geometry?.measurementVersion,
    props.entries,
    rangeTargetKey,
    resourceLayouts,
  ])
  const hasResourceGeometry = Array.from(resourceLayouts).every((layoutKey) =>
    measuredResourceHeights.current.has(layoutKey)
  )
  const hasStructuralEntries = props.entries.some(
    (entry) => entry.kind !== "resource"
  )
  const hasStructuralGeometry =
    !hasStructuralEntries ||
    props.entries
      .filter((entry) => entry.kind !== "resource")
      .every((entry) =>
        measuredStructuralHeights.current.has(
          resourceVirtualEntryLayoutKey(entry)
        )
      )
  const range = useMemo(() => {
    if (!geometry || !hasResourceGeometry || !hasStructuralGeometry) {
      return {
        entries: calibrationEntry ? [calibrationEntry] : [],
        beforeSpacer: 0,
        afterSpacer: 0,
        anchorAdjustment: 0,
        visibleResource: undefined,
        scrollTop: 0,
      }
    }
    return computeResourceVirtualRange(props.entries, {
      ...geometry,
      minimumScrollTop: -geometry.contentOrigin,
      structuralHeights: measuredStructuralHeights.current,
      resourceHeights: measuredResourceHeights.current,
      targetKey: rangeTargetKey,
      retainedAnchor: rangeTargetKey
        ? undefined
        : retainedAnchor.current ?? undefined,
      entryHeights: entryHeights.current,
    })
  }, [
    calibrationEntry,
    geometry,
    hasResourceGeometry,
    hasStructuralGeometry,
    props.entries,
    rangeTargetKey,
  ])
  const contentOrigin = useCallback(
    (element: HTMLElement) => {
      const origin = props.contentOriginRef?.current
      if (!origin || origin === element) return 0
      const offset =
        origin.getBoundingClientRect().top -
        element.getBoundingClientRect().top +
        element.scrollTop
      if (!Number.isFinite(offset) || offset < 0)
        throw new Error(
          `Resource virtual window requires a finite non-negative content origin (received ${offset})`
        )
      return offset
    },
    [props.contentOriginRef]
  )
  const updateGeometry = useCallback(() => {
    const element = owner()
    if (!element) return
    if (element.clientHeight <= 0)
      throw new Error(
        "Resource virtual window requires a positive owner height"
      )
    const origin = contentOrigin(element)
    // Keep the viewport in list coordinates. Negative starts are valid while
    // static controls above the sequence remain visible in the owner.
    const localScrollTop = element.scrollTop - origin
    const nextMeasurementVersion = measurementsDirty.current
      ? ++measurementVersion.current
      : measurementVersion.current
    measurementsDirty.current = false
    setGeometry((previous) => {
      if (
        previous &&
        previous.viewportHeight === element.clientHeight &&
        previous.scrollTop === localScrollTop &&
        previous.contentOrigin === origin &&
        previous.contentOriginVersion === props.contentOriginVersion &&
        previous.measurementVersion === nextMeasurementVersion
      )
        return previous
      return {
        viewportHeight: element.clientHeight,
        scrollTop: localScrollTop,
        contentOrigin: origin,
        contentOriginVersion: props.contentOriginVersion,
        measurementVersion: nextMeasurementVersion,
      }
    })
  }, [contentOrigin, props.contentOriginVersion])
  const scheduleGeometry = useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      updateGeometry()
    })
  }, [updateGeometry])
  useLayoutEffect(() => {
    const element = owner()
    if (!element) return
    if (element.clientHeight <= 0)
      throw new Error(
        "Resource virtual window requires a positive owner height"
      )
    const onScroll = () => {
      retainedAnchor.current = null
      scheduleGeometry()
    }
    element.addEventListener("scroll", onScroll, { passive: true })
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(scheduleGeometry)
      observer.observe(element)
    } else {
      // Some declared browser targets lack ResizeObserver. Their window resize
      // signal is coarser, but it still preserves bounded viewport geometry.
      window.addEventListener("resize", scheduleGeometry)
    }
    updateGeometry()
    return () => {
      element.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", scheduleGeometry)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      observer?.disconnect()
    }
  }, [scheduleGeometry, updateGeometry])
  useLayoutEffect(() => {
    if (
      !geometry ||
      geometryIsStale ||
      (!props.targetKey && !retainedAnchor.current)
    )
      return
    const element = owner()
    if (!element) return
    // The pure range includes every structural row in this offset. Apply it
    // before declaring a mounted target ready; logical-index multiplication
    // drifts as headers enter the list.
    if (range.anchorAdjustment !== 0) {
      const nextScrollTop =
        geometry.contentOrigin + range.scrollTop + range.anchorAdjustment
      if (element.scrollTop !== nextScrollTop) {
        element.scrollTop = nextScrollTop
        updateGeometry()
      }
    }
  }, [
    geometry,
    geometryIsStale,
    props.targetKey,
    range.anchorAdjustment,
    range.scrollTop,
    updateGeometry,
  ])
  useLayoutEffect(() => {
    if (
      geometryIsStale ||
      props.targetKey ||
      range.anchorAdjustment !== 0 ||
      !range.visibleResource
    )
      return
    retainedAnchor.current = range.visibleResource
  }, [
    geometryIsStale,
    props.targetKey,
    range.anchorAdjustment,
    range.visibleResource,
  ])
  useLayoutEffect(() => {
    if (geometryIsStale) return
    if (props.targetKey) {
      // A target owns positioning until its parent consumes completion. Clear
      // any ordinary anchor during the target commit, before that parent can
      // clear targetKey from its own layout-time callback.
      if (activeTarget.current !== props.targetKey)
        retainedAnchor.current = null
      activeTarget.current = props.targetKey
      return
    }
    if (activeTarget.current) {
      // The target's settled viewport becomes the ordinary anchor for the
      // next render. This runs in layout so clearing targetKey cannot reuse
      // the anchor that existed before the explicit navigation request.
      if (completedTarget.current !== activeTarget.current)
        retainedAnchor.current = range.visibleResource ?? null
      activeTarget.current = undefined
    }
    completedTarget.current = null
  }, [geometryIsStale, props.targetKey, range.visibleResource])
  useLayoutEffect(() => {
    if (
      !geometry ||
      geometryIsStale ||
      !props.targetKey ||
      !hasResourceGeometry ||
      !hasStructuralGeometry ||
      completedTarget.current === props.targetKey
    )
      return
    const element = owner()
    const target = mounted.current.get(props.targetKey)
    if (!element || !target || range.anchorAdjustment !== 0) return
    // Preserve the exact target viewport before the parent clears targetKey
    // from this layout callback. The clear render can then never see a stale
    // ordinary anchor or an intermediate geometry snapshot.
    retainedAnchor.current = range.visibleResource ?? null
    completedTarget.current = props.targetKey
    props.onTargetMounted?.(props.targetKey, target)
  }, [
    geometry,
    geometryIsStale,
    hasResourceGeometry,
    hasStructuralGeometry,
    props.targetKey,
    props.onTargetMounted,
    range.anchorAdjustment,
    range.visibleResource,
  ])
  const mount = useCallback(
    (entry: ResourceVirtualEntry<T>, element: HTMLElement | null) => {
      if (!element) {
        if (entry.kind === "resource")
          mounted.current.delete(entry.occurrenceKey)
        return
      }
      const height = element.getBoundingClientRect().height
      if (!Number.isFinite(height) || height <= 0)
        throw new Error(
          `Virtual entry ${resourceVirtualEntryKey(
            entry
          )} must report a finite positive height`
        )
      const key = resourceVirtualMeasurementKey(entry)
      if (entryHeights.current.get(key) !== height) {
        entryHeights.current.set(key, height)
        if (entry.kind === "resource") {
          const layoutKey = resourceVirtualEntryLayoutKey(entry)
          const previous = measuredResourceHeights.current.get(layoutKey)
          if (previous !== undefined && previous !== height)
            throw new Error(
              `Resource layout ${layoutKey} reported incompatible heights ${previous} and ${height}; refine its layout key`
            )
          measuredResourceHeights.current.set(layoutKey, height)
        } else {
          const layoutKey = resourceVirtualEntryLayoutKey(entry)
          const previous = measuredStructuralHeights.current.get(layoutKey)
          if (previous !== undefined && previous !== height)
            throw new Error(
              `Structural layout ${layoutKey} reported incompatible heights ${previous} and ${height}; refine its layout key`
            )
          measuredStructuralHeights.current.set(layoutKey, height)
        }
        // Commit refs run during React's commit phase. Coalesce all row
        // measurements into one browser-frame geometry update. The version
        // bump is immediate: a ref can arrive while an earlier frame is still
        // queued, and waiting solely for that frame could otherwise leave the
        // next calibration class permanently unselected.
        measurementsDirty.current = true
        setGeometry((previous) =>
          previous
            ? {
                ...previous,
                measurementVersion: ++measurementVersion.current,
              }
            : previous
        )
        scheduleGeometry()
      }
      if (entry.kind === "resource") {
        mounted.current.set(entry.occurrenceKey, element)
      }
      props.onMounted?.(entry, element)
    },
    [props, scheduleGeometry]
  )
  const children = (
    <>
      {range.beforeSpacer > 0 &&
        (props.renderSpacer?.(range.beforeSpacer, "before") ?? (
          <div aria-hidden="true" style={{ height: range.beforeSpacer }} />
        ))}
      {props.renderEntries
        ? props.renderEntries(range.entries, (entry, onElement) =>
            props.renderEntry(entry, (element) => {
              mount(entry, element)
              onElement(element)
            })
          )
        : range.entries.map((entry) => (
            <React.Fragment
              key={
                entry.kind === "resource"
                  ? entry.occurrenceKey
                  : entry.kind === "group-header"
                  ? entry.groupId
                  : entry.sectionId
              }
            >
              {props.renderEntry(entry, (element) => mount(entry, element))}
            </React.Fragment>
          ))}
      {range.afterSpacer > 0 &&
        (props.renderSpacer?.(range.afterSpacer, "after") ?? (
          <div aria-hidden="true" style={{ height: range.afterSpacer }} />
        ))}
    </>
  )
  return props.asFragment ? (
    children
  ) : (
    <div ref={ownRef} data-resource-virtual-window="true">
      {children}
    </div>
  )
}
