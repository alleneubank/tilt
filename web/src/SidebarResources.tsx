import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { flushSync } from "react-dom"
import { Link } from "react-router-dom"
import styled from "styled-components"
import { FeaturesContext, Flag } from "./feature"
import { orderLabels, TILTFILE_LABEL, UNLABELED_LABEL } from "./labels"
import { OverviewSidebarOptions } from "./OverviewSidebarOptions"
import PathBuilder from "./PathBuilder"
import {
  ResourceGroupsInfoTip,
  ResourceGroupSummaryIcon,
} from "./ResourceGroups"
import { useResourceGroups } from "./ResourceGroupsContext"
import { ResourceListOptions } from "./ResourceListOptionsContext"
import {
  buildSidebarVirtualModel,
  findResourceOccurrence,
  ResourceVirtualEntry,
  ResourceVirtualResourceEntry,
} from "./ResourceVirtualModel"
import { ResourceVirtualWindow } from "./ResourceVirtualWindow"
import { matchesResourceName } from "./ResourceNameFilter"
import { SidebarGroupStatusSummary } from "./ResourceStatusSummary"
import SidebarItem from "./SidebarItem"
import SidebarItemView, { sidebarItemIsDisabled } from "./SidebarItemView"
import SidebarKeyboardShortcuts, {
  OccurrenceCursorRequest,
} from "./SidebarKeyboardShortcuts"
import {
  AnimDuration,
  Color,
  Font,
  FontSize,
  mixinTruncateText,
  SizeUnit,
} from "./style-helpers"
import { startBuild } from "./trigger"
import { ResourceName, ResourceStatus, ResourceView } from "./types"
import { useStarredResources } from "./StarredResourcesContext"

export type SidebarProps = {
  items: SidebarItem[]
  selected: string
  resourceView: ResourceView
  pathBuilder: PathBuilder
  resourceListOptions: ResourceListOptions
}

export let SidebarResourcesRoot = styled.nav`
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  &.isOverview {
    flex-shrink: 1;
  }
`
const SidebarResourcesContent = styled.div`
  margin-bottom: ${SizeUnit(1.75)};
`
const SidebarListSectionName = styled.div`
  ${mixinTruncateText};
  box-sizing: border-box;
  display: block;
  max-width: 100%;
  margin-top: 0;
  margin-left: ${SizeUnit(0.5)};
  text-transform: uppercase;
  color: ${Color.gray50};
  font-size: ${FontSize.small};
`
const BuiltinResourceLinkRoot = styled(Link)`
  background-color: ${Color.gray40};
  border: 1px solid ${Color.gray50};
  border-radius: ${SizeUnit(1 / 8)};
  color: ${Color.white};
  display: block;
  font-family: ${Font.sansSerif};
  font-size: ${FontSize.smallest};
  font-weight: normal;
  margin: ${SizeUnit(1 / 3)} ${SizeUnit(1 / 2)};
  padding: ${SizeUnit(1 / 5)} ${SizeUnit(1 / 3)};
  text-decoration: none;
  transition: all ${AnimDuration.default} ease;
  &:is(:hover, :focus, :active) {
    background-color: ${Color.gray30};
  }
  &.isSelected {
    background-color: ${Color.gray70};
    color: ${Color.gray30};
    font-weight: 600;
  }
`
export const SidebarListSectionItemsRoot = styled.ul`
  margin-top: ${SizeUnit(0.25)};
  list-style: none;
`
export const SidebarDisabledSectionList = styled.li`
  box-sizing: border-box;
  color: ${Color.gray60};
  font-family: ${Font.sansSerif};
  font-size: ${FontSize.small};
  /* Keep the title's old vertical rhythm inside the measured root border box. */
  padding-bottom: ${SizeUnit(1 / 12)};
  padding-top: ${SizeUnit(1 / 3)};
`
export const SidebarDisabledSectionTitle = styled.span`
  display: block;
  padding-left: ${SizeUnit(3 / 4)};
`
const NoMatchesFound = styled.li`
  margin-left: ${SizeUnit(0.5)};
  color: ${Color.grayLightest};
`
const SidebarGroupHeaderRoot = styled.li`
  box-sizing: border-box;
  padding: ${SizeUnit(1 / 3)} ${SizeUnit(1 / 2)};
`
const SidebarTiltfileHeaderRoot = styled.li`
  box-sizing: border-box;
  padding-top: ${SizeUnit(0.5)};
`
const SidebarGroupButton = styled.button`
  background-color: ${Color.gray40};
  border: 1px solid ${Color.gray50};
  border-radius: ${SizeUnit(1 / 8)};
  color: ${Color.white};
  cursor: pointer;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  font-size: ${FontSize.small};
  margin: 0;
  width: 100%;
  padding: ${SizeUnit(1 / 8)};

  ${ResourceGroupSummaryIcon} {
    transform: rotate(0deg);
  }

  &[aria-expanded="true"] ${ResourceGroupSummaryIcon} {
    transform: rotate(90deg);
  }
`
export const SidebarGroupName = styled.span`
  ${mixinTruncateText};
  min-width: 0;
  margin-right: auto;
  width: 100%;
`
const GROUP_INFO_TOOLTIP_ID = "sidebar-groups-info"

function AllResourcesLink(props: {
  pathBuilder: PathBuilder
  selected: string
}) {
  return (
    <BuiltinResourceLinkRoot
      className={props.selected === "" ? "isSelected" : ""}
      aria-label="View all resource logs"
      to={props.pathBuilder.encpath`/r/(all)/overview`}
    >
      All Resources
    </BuiltinResourceLinkRoot>
  )
}
function StarredResourcesLink(props: {
  pathBuilder: PathBuilder
  selected: string
}) {
  const starContext = useStarredResources()
  if (!starContext.starredResources.length) return null
  return (
    <BuiltinResourceLinkRoot
      className={props.selected === ResourceName.starred ? "isSelected" : ""}
      aria-label="View starred resource logs"
      to={props.pathBuilder.encpath`/r/(starred)/overview`}
    >
      Starred Resources
    </BuiltinResourceLinkRoot>
  )
}
function hasAlerts(item: SidebarItem) {
  return item.buildAlertCount > 0 || item.runtimeAlertCount > 0
}
function applyOptionsToItems(
  items: SidebarItem[],
  options: ResourceListOptions
) {
  let result = items.filter(
    (item) =>
      options.showDisabledResources ||
      item.runtimeStatus !== ResourceStatus.Disabled
  )
  if (options.resourceNameFilter)
    result = result.filter((item) =>
      matchesResourceName(item.name, options.resourceNameFilter)
    )
  if (options.alertsOnTop)
    result = [...result].sort(
      (a, b) => Number(hasAlerts(b)) - Number(hasAlerts(a))
    )
  return result
}

type PendingOccurrence = OccurrenceCursorRequest
type OccurrenceNavigationRequest = Extract<
  PendingOccurrence,
  { kind: "occurrence" }
>

/**
 * Resolves a request against the immutable logical projection shared by the
 * virtual range and keyboard traversal. A vanished occurrence invalidates
 * the request rather than inventing a cursor for a different logical row.
 */
function reconcileOccurrenceRequest(
  request: OccurrenceNavigationRequest | undefined,
  logicalResources: ReadonlyArray<ResourceVirtualResourceEntry<SidebarItem>>
): OccurrenceNavigationRequest | undefined {
  if (!request) return undefined
  if (
    logicalResources.some(
      (entry) => entry.occurrenceKey === request.occurrenceKey
    )
  )
    return request
  return undefined
}

function SidebarVirtualList(
  props: SidebarProps & {
    grouped: boolean
    tip: boolean
    sectionName: string
    ownerRef: React.RefObject<HTMLElement>
    contentOriginRef: React.RefObject<HTMLUListElement>
  }
) {
  const { getGroup, toggleGroupExpanded } = useResourceGroups()
  const { starredResources } = useStarredResources()
  // These are every known branch above the origin list with a different
  // footprint. The window still measures the resulting origin; this merely
  // makes a position-only chrome change observable to its layout effect.
  const contentOriginVersion = `${props.tip}:${starredResources.length > 0}:${
    props.grouped
  }`
  const groupState = useMemo(() => {
    const state: Record<string, boolean> = {}
    props.items.forEach((item) =>
      item.labels.forEach((label) => {
        state[label] = getGroup(label).expanded
      })
    )
    state[UNLABELED_LABEL] = getGroup(UNLABELED_LABEL).expanded
    state[TILTFILE_LABEL] = getGroup(TILTFILE_LABEL).expanded
    return state
  }, [getGroup, props.items])
  const [navigationRequest, setNavigationRequest] = useState<
    PendingOccurrence | undefined
  >()
  const nextRequestId = useRef(0)
  // One typed request is the source of truth for mounting, route settlement,
  // and keyboard traversal. Keyboard requests deliberately remain effective
  // while the router is delayed; completed pointer bridges do not.
  const navigationOwnsSelection =
    navigationRequest &&
    (navigationRequest.origin === "keyboard" ||
      navigationRequest.phase === "positioning" ||
      navigationRequest.resourceName === props.selected)
  const effectiveSelectedName = navigationOwnsSelection
    ? navigationRequest.resourceName
    : props.selected
  const model = useMemo(
    () =>
      buildSidebarVirtualModel<SidebarItem>({
        items: props.items,
        isDisabled: sidebarItemIsDisabled,
        isTiltfile: (item) => item.isTiltfile,
        labelsForItem: (item) => item.labels,
        nameForItem: (item) => item.name,
        layoutKeyForItem: (_item, section, flow) => `${section}-${flow}`,
        sortLabels: orderLabels,
        groupState,
        selectedName: effectiveSelectedName,
        grouped: props.grouped,
      }),
    [effectiveSelectedName, groupState, props.grouped, props.items]
  )
  const renderTarget = useMemo(() => {
    if (
      navigationRequest?.kind !== "occurrence" ||
      navigationRequest.phase !== "positioning"
    )
      return undefined
    return reconcileOccurrenceRequest(navigationRequest, model.logicalResources)
  }, [model.logicalResources, navigationRequest, props.selected])
  // A positioned pointer request only becomes a logical cursor once its route
  // selects the requested resource. Keyboard requests own the cursor across a
  // delayed route write, so repeated native traversal can compose immediately.
  const cursorRequest =
    navigationRequest &&
    (navigationRequest.origin === "keyboard" ||
      navigationRequest.resourceName === props.selected)
      ? navigationRequest
      : undefined
  const previousSelectedName = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const previousSelection = previousSelectedName.current
    const selectionChanged = previousSelection !== props.selected
    previousSelectedName.current = props.selected
    setNavigationRequest((current) => {
      const selectedFallback = () => {
        const fallback = findResourceOccurrence(
          model.logicalResources,
          props.selected
        )
        return fallback
          ? {
              kind: "occurrence" as const,
              occurrenceKey: fallback.occurrenceKey,
              resourceName: fallback.resourceName,
              requestId: ++nextRequestId.current,
              origin: "pointer" as const,
              phase: "positioning" as const,
            }
          : undefined
      }
      const currentExists =
        current?.kind === "aggregate" ||
        model.logicalResources.some(
          (entry) =>
            current?.kind === "occurrence" &&
            entry.occurrenceKey === current.occurrenceKey
        )
      if (!current) return selectedFallback()
      if (!currentExists) {
        const currentOwnsSelection =
          current.kind === "occurrence" &&
          (current.origin === "keyboard" ||
            current.phase === "positioning" ||
            current.resourceName === props.selected)
        const replacement = currentOwnsSelection
          ? findResourceOccurrence(model.logicalResources, current.resourceName)
          : undefined
        if (replacement)
          // Retain an owning request's identity while its projection changes.
          // Re-enter positioning so the window mounts and focuses the exact
          // replacement occurrence before route settlement can consume it.
          return {
            ...current,
            occurrenceKey: replacement.occurrenceKey,
            phase: "positioning",
          }
        // Direct route replay can settle its selected name before the next
        // immutable projection includes that resource. When the request does
        // not own selection, or its resource vanished entirely, use the route
        // selection rather than inventing a cursor.
        return selectedFallback()
      }
      // Route acknowledgement must not consume a positioning request before
      // the virtual window has mounted and focused its exact target.
      if (current.resourceName === props.selected)
        return current.phase === "positioning"
          ? current
          : { ...current, phase: "settled" }
      // A later route change is an external selection. Leaving a route prop
      // stale is not a change and must preserve a keyboard-owned cursor.
      if (selectionChanged && previousSelection !== undefined)
        return selectedFallback()
      return current
    })
  }, [model.logicalResources, props.selected])
  const onTargetMounted = useCallback(
    (key: string, element: HTMLElement) => {
      if (key !== renderTarget?.occurrenceKey) return
      // Focus the resource control after the pure range has positioned its owner.
      element.querySelector<HTMLElement>("[data-name]")?.focus()
      setNavigationRequest((current) => {
        if (
          current?.kind !== "occurrence" ||
          current.occurrenceKey !== key ||
          current.phase !== "positioning"
        )
          return current
        return {
          ...current,
          phase:
            current.resourceName === props.selected
              ? "settled"
              : "awaiting-route",
        }
      })
    },
    [props.selected, renderTarget]
  )
  const requestOccurrence = useCallback(
    (
      entry: ResourceVirtualResourceEntry<SidebarItem>,
      origin: OccurrenceCursorRequest["origin"] = "pointer"
    ) => {
      // Commit the occurrence before a route update can cause a same-name
      // selection sync. This matters for both native keyboard listeners and
      // mouse activation of duplicate label occurrences.
      const request = {
        kind: "occurrence" as const,
        occurrenceKey: entry.occurrenceKey,
        resourceName: entry.resourceName,
        requestId: ++nextRequestId.current,
        origin,
        phase: "positioning" as const,
      }
      flushSync(() => {
        setNavigationRequest(request)
      })
    },
    []
  )
  const requestAll = useCallback(() => {
    flushSync(() => {
      setNavigationRequest({
        kind: "aggregate",
        resourceName: ResourceName.all,
        requestId: ++nextRequestId.current,
        origin: "keyboard",
        phase: "settled",
      })
    })
  }, [])
  const renderEntry = (
    entry: ResourceVirtualEntry<SidebarItem>,
    onElement: (element: HTMLElement | null) => void
  ) => {
    switch (entry.kind) {
      case "resource":
        return (
          <SidebarItemView
            groupView={entry.groupId === "tiltfile"}
            flattenedGroupView={props.grouped && entry.groupId !== "tiltfile"}
            item={entry.item}
            selected={props.selected === entry.resourceName}
            pathBuilder={props.pathBuilder}
            resourceView={props.resourceView}
            rootRef={onElement}
            flow={entry.flow}
            occurrenceKey={entry.occurrenceKey}
            onRequestOccurrence={() => requestOccurrence(entry, "pointer")}
          />
        )
      case "disabled-header":
        return (
          <SidebarDisabledSectionList ref={onElement}>
            <SidebarDisabledSectionTitle
              id={`sidebar-disabled-heading-${encodeURIComponent(
                entry.sectionId
              )}`}
            >
              Disabled
            </SidebarDisabledSectionTitle>
          </SidebarDisabledSectionList>
        )
      case "group-header":
        return entry.collapsible ? (
          <SidebarGroupHeaderRoot ref={onElement}>
            <SidebarGroupButton
              type="button"
              id={`sidebar-group-toggle-${encodeURIComponent(entry.groupId)}`}
              aria-expanded={entry.expanded}
              aria-controls={`sidebar-group-region-${encodeURIComponent(
                entry.groupId
              )}`}
              onClick={() => toggleGroupExpanded(entry.label)}
            >
              <ResourceGroupSummaryIcon role="presentation" />
              <SidebarGroupName title={entry.label}>
                {entry.label === UNLABELED_LABEL ? (
                  <em>{entry.label}</em>
                ) : (
                  entry.label
                )}
              </SidebarGroupName>
              <SidebarGroupStatusSummary
                labelText={`Status summary for ${entry.label} group`}
                resources={[...entry.members]}
              />
            </SidebarGroupButton>
          </SidebarGroupHeaderRoot>
        ) : entry.groupId === "tiltfile" ? (
          <SidebarTiltfileHeaderRoot
            ref={onElement}
            aria-label={`${entry.label} resources`}
          >
            <SidebarListSectionName>{entry.label}</SidebarListSectionName>
          </SidebarTiltfileHeaderRoot>
        ) : (
          <SidebarDisabledSectionList ref={onElement}>
            <SidebarDisabledSectionTitle>
              {entry.label}
            </SidebarDisabledSectionTitle>
          </SidebarDisabledSectionList>
        )
    }
  }
  const renderEntries = (
    entries: ReadonlyArray<ResourceVirtualEntry<SidebarItem>>,
    render: (
      entry: ResourceVirtualEntry<SidebarItem>,
      onElement: (element: HTMLElement | null) => void
    ) => React.ReactNode
  ) => {
    const renderCurrentEntry = (entry: ResourceVirtualEntry<SidebarItem>) => (
      <React.Fragment
        key={
          entry.kind === "resource"
            ? entry.occurrenceKey
            : entry.kind === "group-header"
            ? entry.groupId
            : entry.sectionId
        }
      >
        {render(entry, () => undefined)}
      </React.Fragment>
    )
    if (!props.grouped) {
      // Filtering deliberately presents one ordinary result list. The model's
      // ungrouped identity is logical-only here: exposing it as a labeled
      // region would falsely announce an "unlabeled" group for a real label.
      const resources = entries.filter(
        (entry): entry is ResourceVirtualResourceEntry<SidebarItem> =>
          entry.kind === "resource"
      )
      const enabled = resources.filter((entry) => entry.section !== "disabled")
      const disabled = resources.filter((entry) => entry.section === "disabled")
      const disabledHeader = entries.find(
        (entry) => entry.kind === "disabled-header"
      )
      return [
        ...enabled.map(renderCurrentEntry),
        disabledHeader ? renderCurrentEntry(disabledHeader) : null,
        disabled.length ? (
          <li key="disabled-list:ungrouped" role="none">
            <ul
              aria-label="Disabled resources"
              style={{ listStyle: "none", margin: 0, padding: 0 }}
            >
              {disabled.map(renderCurrentEntry)}
            </ul>
          </li>
        ) : null,
      ]
    }
    type GroupChunk = {
      groupId: string
      entries: ResourceVirtualEntry<SidebarItem>[]
    }
    const output: React.ReactNode[] = []
    const headerGroupIds = new Set<string>()
    const renderedGroupIds = new Set<string>()
    let chunk: GroupChunk | undefined
    const flushChunk = () => {
      if (!chunk) return
      const current = chunk
      chunk = undefined
      const group = model.groups.get(current.groupId)
      renderedGroupIds.add(current.groupId)
      const groupLabel = group?.label ?? current.groupId
      const resources = current.entries.filter(
        (entry): entry is ResourceVirtualResourceEntry<SidebarItem> =>
          entry.kind === "resource"
      )
      const enabled = resources.filter((entry) => entry.section !== "disabled")
      const disabled = resources.filter((entry) => entry.section === "disabled")
      const disabledHeader = current.entries.find(
        (entry) => entry.kind === "disabled-header"
      )
      output.push(
        <li
          key={`region:${current.groupId}`}
          id={`sidebar-group-region-${encodeURIComponent(current.groupId)}`}
          role="region"
          aria-label={`${groupLabel} resources`}
          style={{ listStyle: "none" }}
        >
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {enabled.map(renderCurrentEntry)}
            {disabledHeader ? renderCurrentEntry(disabledHeader) : null}
            {disabled.length ? (
              <li key={`disabled-list:${current.groupId}`} role="none">
                <ul
                  aria-label="Disabled resources"
                  style={{ listStyle: "none", margin: 0, padding: 0 }}
                >
                  {disabled.map(renderCurrentEntry)}
                </ul>
              </li>
            ) : null}
          </ul>
        </li>
      )
    }
    entries.forEach((entry) => {
      if (entry.kind === "group-header") {
        flushChunk()
        headerGroupIds.add(entry.groupId)
        output.push(
          <React.Fragment key={`header:${entry.groupId}`}>
            {render(entry, () => undefined)}
          </React.Fragment>
        )
        return
      }
      if (!chunk || chunk.groupId !== entry.groupId) {
        flushChunk()
        chunk = { groupId: entry.groupId, entries: [] }
      }
      chunk.entries.push(entry)
    })
    flushChunk()
    headerGroupIds.forEach((groupId) => {
      if (renderedGroupIds.has(groupId)) return
      const group = model.groups.get(groupId)
      output.push(
        <li
          key={`empty-region:${groupId}`}
          id={`sidebar-group-region-${encodeURIComponent(groupId)}`}
          role="region"
          aria-label={`${group?.label ?? groupId} resources`}
          style={{ height: 0, listStyle: "none", overflow: "hidden" }}
        />
      )
    })
    return output
  }
  if (!props.items.length && props.sectionName !== "resources")
    return (
      <>
        <SidebarListSectionItemsRoot ref={props.contentOriginRef}>
          <NoMatchesFound>No matching resources</NoMatchesFound>
        </SidebarListSectionItemsRoot>
        <SidebarKeyboardShortcuts
          selected={props.selected}
          items={model.logicalResources}
          onRequestOccurrence={(
            entry: ResourceVirtualResourceEntry<SidebarItem>
          ) => requestOccurrence(entry, "keyboard")}
          onRequestAll={requestAll}
          onStartBuild={() => props.selected && startBuild(props.selected)}
          resourceView={props.resourceView}
          cursorRequest={cursorRequest}
        />
      </>
    )
  return (
    <>
      {!props.grouped && (
        <SidebarListSectionName>{props.sectionName}</SidebarListSectionName>
      )}
      <SidebarListSectionItemsRoot ref={props.contentOriginRef}>
        <ResourceVirtualWindow
          entries={model.entries}
          scrollOwnerRef={props.ownerRef}
          contentOriginRef={props.contentOriginRef}
          contentOriginVersion={contentOriginVersion}
          targetKey={renderTarget?.occurrenceKey}
          onTargetMounted={onTargetMounted}
          renderEntry={renderEntry}
          renderEntries={renderEntries}
          asFragment
          renderSpacer={(height) => (
            <li aria-hidden="true" style={{ height }} />
          )}
        />
      </SidebarListSectionItemsRoot>
      <SidebarKeyboardShortcuts
        selected={props.selected}
        items={model.logicalResources}
        onRequestOccurrence={(
          entry: ResourceVirtualResourceEntry<SidebarItem>
        ) => requestOccurrence(entry, "keyboard")}
        onRequestAll={requestAll}
        onStartBuild={() => props.selected && startBuild(props.selected)}
        resourceView={props.resourceView}
        cursorRequest={cursorRequest}
      />
    </>
  )
}

export class SidebarResources extends React.Component<SidebarProps> {
  static contextType = FeaturesContext
  private readonly ownerRef = React.createRef<HTMLElement>()
  private readonly contentOriginRef = React.createRef<HTMLUListElement>()
  state = { ownerReady: false }
  private setOwner = (element: HTMLElement | null) => {
    ;(this.ownerRef as React.MutableRefObject<HTMLElement | null>).current =
      element
    if (element && !this.state.ownerReady) this.setState({ ownerReady: true })
  }
  render() {
    const filteredItems = applyOptionsToItems(
      this.props.items,
      this.props.resourceListOptions
    )
    const filterApplied =
      this.props.resourceListOptions.resourceNameFilter.length > 0
    const sectionName = filterApplied
      ? `${filteredItems.length} result${filteredItems.length === 1 ? "" : "s"}`
      : "resources"
    const labelsEnabled = this.context.isEnabled(Flag.Labels)
    const resourcesHaveLabels = this.props.items.some(
      (item) => item.labels.length > 0
    )
    const grouped = !filterApplied && labelsEnabled && resourcesHaveLabels
    const tip = labelsEnabled && !resourcesHaveLabels
    const isOverviewClass =
      this.props.resourceView === ResourceView.OverviewDetail
        ? "isOverview"
        : ""
    return (
      <SidebarResourcesRoot
        ref={this.setOwner}
        aria-label="Resource logs"
        className={`Sidebar-resources ${isOverviewClass}`}
      >
        {tip && <ResourceGroupsInfoTip idForIcon={GROUP_INFO_TOOLTIP_ID} />}
        <SidebarResourcesContent
          aria-describedby={tip ? GROUP_INFO_TOOLTIP_ID : undefined}
        >
          <OverviewSidebarOptions items={filteredItems} />
          <AllResourcesLink
            pathBuilder={this.props.pathBuilder}
            selected={this.props.selected}
          />
          <StarredResourcesLink
            pathBuilder={this.props.pathBuilder}
            selected={this.props.selected}
          />
          {this.state.ownerReady && (
            <SidebarVirtualList
              {...this.props}
              items={filteredItems}
              grouped={grouped}
              tip={tip}
              sectionName={sectionName}
              ownerRef={this.ownerRef}
              contentOriginRef={this.contentOriginRef}
            />
          )}
        </SidebarResourcesContent>
      </SidebarResourcesRoot>
    )
  }
}
export default SidebarResources
