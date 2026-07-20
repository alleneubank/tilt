import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { flushSync } from "react-dom"
import {
  HeaderGroup,
  Row,
  SortingRule,
  TableHeaderProps,
  TableState,
  useSortBy,
  UseSortByState,
  useTable,
} from "react-table"
import styled from "styled-components"
import { buildAlerts, runtimeAlerts } from "./alerts"
import { ApiButtonType, buttonsForComponent } from "./ApiButton"
import Features, { Flag, useFeatures } from "./feature"
import { Hold } from "./Hold"
import {
  getResourceLabels,
  GroupByLabelView,
  orderLabels,
  TILTFILE_LABEL,
  UNLABELED_LABEL,
} from "./labels"
import { LogAlertIndex, useLogAlertIndex } from "./LogStore"
import {
  COLUMNS,
  ResourceTableHeaderTip,
  rowIsDisabled,
  RowValues,
  SelectionCheckbox,
} from "./OverviewTableColumns"
import {
  OverviewTableKeyboardShortcuts,
  reconcileOverviewOccurrence,
} from "./OverviewTableKeyboardShortcuts"
import {
  ResourceGroupsInfoTip,
  ResourceGroupSummaryIcon,
} from "./ResourceGroups"
import { useResourceGroups } from "./ResourceGroupsContext"
import {
  ResourceListOptions,
  useResourceListOptions,
} from "./ResourceListOptionsContext"
import { matchesResourceName } from "./ResourceNameFilter"
import { useResourceSelection } from "./ResourceSelectionContext"
import { resourceIsDisabled, resourceTargetType } from "./ResourceStatus"
import {
  ResourceStatusSummaryRoot,
  TableGroupStatusSummary,
} from "./ResourceStatusSummary"
import {
  buildSidebarVirtualModel,
  ResourceVirtualEntry,
  ResourceVirtualGroup,
  ResourceVirtualResourceEntry,
} from "./ResourceVirtualModel"
import { ResourceVirtualWindow } from "./ResourceVirtualWindow"
import { buildStatus, runtimeStatus } from "./status"
import { Color, Font, FontSize, SizeUnit } from "./style-helpers"
import { isZeroTime, timeDiff } from "./time"
import {
  ResourceName,
  ResourceStatus,
  TargetType,
  TriggerMode,
  UIButton,
  UIResource,
  UIResourceStatus,
} from "./types"
import type { View } from "./webview"

export type OverviewTableProps = {
  view: View
}

type ResourceTableHeadRowProps = {
  headerGroup: HeaderGroup<RowValues>
  setGlobalSortBy?: (id: string) => void
} & TableHeaderProps

// Resource name filter styles
export const ResourceResultCount = styled.p`
  color: ${Color.gray50};
  font-size: ${FontSize.small};
  margin-top: ${SizeUnit(0.5)};
  margin-left: ${SizeUnit(0.5)};
  text-transform: uppercase;
`

export const NoMatchesFound = styled.p`
  color: ${Color.grayLightest};
  margin-left: ${SizeUnit(0.5)};
  margin-top: ${SizeUnit(1 / 4)};
`

// Table styles
const OverviewTableRoot = styled.section`
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: auto;
  overflow-y: auto;
  padding-bottom: ${SizeUnit(1 / 2)};
`

const OverviewTableContentRoot = styled.div`
  margin-left: auto;
  margin-right: auto;
  max-width: 2000px;
  min-width: 1400px;

  @media screen and (max-width: 2200px) {
    margin-left: ${SizeUnit(1 / 2)};
    margin-right: ${SizeUnit(1 / 2)};
  }
`

const ResourceTable = styled.table`
  table-layout: fixed;
  width: 100%;
  border-spacing: 0;
  border-collapse: separate;

  td,
  th {
    padding-left: 10px;
    padding-right: 10px;
  }

  td:first-child,
  th:first-child {
    padding-left: 24px;
  }

  td:last-child,
  th:last-child {
    padding-right: ${SizeUnit(1)};
  }

  tbody.overviewGroupBody,
  tbody.overviewUngroupedBody {
    background-color: ${Color.gray20};
  }

  tbody.overviewGroupBody.isExpanded,
  tbody.overviewUngroupedBody {
    box-shadow: 0 4px 4px rgba(0, 0, 0, 0.25);
  }

  tbody.overviewGroupBody,
  tbody.overviewUngroupedBody {
    border-bottom-left-radius: ${SizeUnit(1 / 4)};
    border-bottom-right-radius: ${SizeUnit(1 / 4)};
  }
`
const VirtualSpacerCell = styled.td`
  border: 0;
  padding: 0 !important;
`
const OverviewGroupSpacerCell = styled(VirtualSpacerCell)`
  background: transparent !important;
  box-shadow: none;
  height: ${SizeUnit(1 / 2)};
`
const OverviewGroupSummary = styled.div`
  align-items: center;
  background-color: ${Color.gray10};
  border: 0;
  color: ${Color.white};
  display: flex;
  font-family: ${Font.sansSerif};
  cursor: pointer;
  font-size: ${FontSize.default};
  gap: ${SizeUnit(1 / 4)};
  margin-top: 0;
  min-width: 0;
  padding: ${SizeUnit(1 / 8)};
  text-align: left;
  white-space: nowrap;

  &[aria-expanded="true"] ${ResourceGroupSummaryIcon} {
    transform: rotate(90deg);
  }

  ${ResourceStatusSummaryRoot} {
    flex: 0 1 auto;
    margin-left: auto;
    white-space: nowrap;
  }
`
const ResourceTableHead = styled.thead`
  & > tr {
    background-color: ${Color.gray10};
  }
`
const GroupedResourceTableHead = styled(ResourceTableHead)`
  border: 0;
  clip: rect(0 0 0 0);
  height: 1px;
  margin: -1px;
  overflow: hidden;
  padding: 0;
  position: absolute;
  white-space: nowrap;
  width: 1px;
`

export const ResourceTableRow = styled.tr`
  box-sizing: border-box;
  font-family: ${Font.monospace};
  font-size: ${FontSize.small};
  font-style: none;
  color: ${Color.gray60};

  /* Only measured resource rows use the historic 66px density. */
  &.isResource {
    height: 4em;
  }

  &.isFocused,
  &:focus {
    outline: none;

    td:first-child {
      border-left: 4px solid ${Color.blue};
      padding-left: 20px;
    }
  }

  &.isSelected {
    background-color: ${Color.gray30};
  }

  /* A group panel is cell-owned so separated table borders keep measured
   * heights exact while a continuation slice still reads as one surface. */
  &.isOverviewPanelResource td {
    background-color: ${Color.gray20};
  }

  &.isOverviewPanelResource td:first-child {
    border-left: 1px solid ${Color.gray40};
  }

  &.isOverviewPanelResource td:last-child {
    border-right: 1px solid ${Color.gray40};
  }

  /* Panel fills belong to cells, so restore selection and focus after those
   * opaque side rules instead of relying on the row's hidden background. */
  &.isOverviewPanelResource.isSelected td {
    background-color: ${Color.gray30};
  }

  &.isOverviewPanelResource.isFocused td:first-child {
    border-left: 4px solid ${Color.blue};
    padding-left: 20px;
  }

  &.isOverviewPanelLastResource td {
    /* Paint the panel edge without changing this measured row's geometry. */
    box-shadow: inset 0 -1px 0 ${Color.gray40};
  }

  &.isOverviewPanelLastResource td:first-child {
    border-bottom-left-radius: ${SizeUnit(1 / 4)};
  }

  &.isOverviewPanelLastResource td:last-child {
    border-bottom-right-radius: ${SizeUnit(1 / 4)};
  }

  /* For visual consistency on rows */
  &.isFixedHeight {
    height: ${SizeUnit(1.4)};
  }
`
export const ResourceTableData = styled.td`
  box-sizing: border-box;
  border-top: 1px solid ${Color.gray40};
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &.isSorted {
    background-color: ${Color.gray30};
  }

  &.alignRight {
    text-align: right;
  }

  &.overviewGroupHeaderCell {
    background-color: ${Color.gray10};
    border-left: 1px solid ${Color.gray40};
    border-right: 1px solid ${Color.gray40};
    border-top: 1px solid ${Color.gray40};
    border-top-left-radius: ${SizeUnit(1 / 4)};
    border-top-right-radius: ${SizeUnit(1 / 4)};
    max-width: none;
    overflow: visible;
    padding: 0 !important;
    white-space: normal;
  }

  tbody.isCollapsed &.overviewGroupHeaderCell {
    border-bottom: 1px solid ${Color.gray40};
    border-bottom-left-radius: ${SizeUnit(1 / 4)};
    border-bottom-right-radius: ${SizeUnit(1 / 4)};
  }
`

export const ResourceTableHeader = styled(ResourceTableData)`
  color: ${Color.gray70};
  font-size: ${FontSize.small};
  box-sizing: border-box;
  white-space: nowrap;

  &.isSorted {
    background-color: ${Color.gray20};
  }
`
const OverviewGroupColumnHeader = styled(ResourceTableHeader)`
  /* These native headers live in a tbody, so they must own the panel paint
   * normally inherited from ResourceTableHead. */
  background-color: ${Color.gray10};

  &:first-child {
    border-left: 1px solid ${Color.gray40};
  }

  &:last-child {
    border-right: 1px solid ${Color.gray40};
  }

  &.isSorted {
    background-color: ${Color.gray20};
  }
`

const ResourceTableHeaderLabel = styled.div`
  display: flex;
  align-items: center;
  user-select: none;
`

export const ResourceTableHeaderSortTriangle = styled.div`
  display: inline-block;
  margin-left: ${SizeUnit(0.25)};
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-bottom: 6px solid ${Color.gray50};

  &.is-sorted-asc {
    border-bottom: 6px solid ${Color.blue};
  }
  &.is-sorted-desc {
    border-bottom: 6px solid ${Color.blue};
    transform: rotate(180deg);
  }
`

const OverviewGroupName = styled.span`
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  padding: 0 ${SizeUnit(1 / 3)};
  text-overflow: ellipsis;
  white-space: nowrap;
`

const GROUP_INFO_TOOLTIP_ID = "table-groups-info"

export function TableResourceResultCount(props: { resources?: UIResource[] }) {
  const { options } = useResourceListOptions()

  if (
    props.resources === undefined ||
    options.resourceNameFilter.length === 0
  ) {
    return null
  }

  const count = props.resources.length

  return (
    <ResourceResultCount>
      {count} result{count !== 1 ? "s" : ""}
    </ResourceResultCount>
  )
}

export function TableNoMatchesFound(props: { resources?: UIResource[] }) {
  const { options } = useResourceListOptions()

  if (props.resources?.length === 0 && options.resourceNameFilter.length > 0) {
    return <NoMatchesFound>No matching resources</NoMatchesFound>
  }

  return null
}

const FIRST_SORT_STATE = false
const SECOND_SORT_STATE = true

// This helper function manually implements the toggle sorting
// logic used by react-table, so we can keep the sorting state
// globally and sort multiple tables by the same column.
//    Click once to sort by ascending values
//    Click twice to sort by descending values
//    Click thrice to remove sort
// Note: this does NOT support sorting by multiple columns.
function calculateNextSort(
  id: string,
  sortByState: SortingRule<RowValues>[] | undefined
): SortingRule<RowValues>[] {
  if (!sortByState || sortByState.length === 0) {
    return [{ id, desc: FIRST_SORT_STATE }]
  }

  // If the current sort is the same column as next sort,
  // determine its next value
  const [currentSort] = sortByState
  if (currentSort.id === id) {
    const { desc } = currentSort

    if (desc === undefined) {
      return [{ id, desc: FIRST_SORT_STATE }]
    }

    if (desc === FIRST_SORT_STATE) {
      return [{ id, desc: SECOND_SORT_STATE }]
    }

    if (desc === SECOND_SORT_STATE) {
      return []
    }
  }

  return [{ id, desc: FIRST_SORT_STATE }]
}

function applyOptionsToResources(
  resources: UIResource[] | undefined,
  options: ResourceListOptions,
  features: Features
): UIResource[] {
  if (!resources) {
    return []
  }

  const hideDisabledResources = !options.showDisabledResources
  const resourceNameFilter = options.resourceNameFilter.length > 0

  // If there are no options to apply to the resources, return the un-filtered, sorted list
  if (!resourceNameFilter && !hideDisabledResources) {
    return sortByDisableStatus(resources)
  }

  // Otherwise, apply the options to the resources and sort it
  const filteredResources = resources.filter((r) => {
    const resourceDisabled = resourceIsDisabled(r)
    if (hideDisabledResources && resourceDisabled) {
      return false
    }

    if (resourceNameFilter) {
      return matchesResourceName(
        r.metadata?.name || "",
        options.resourceNameFilter
      )
    }

    return true
  })

  return sortByDisableStatus(filteredResources)
}

function uiResourceToCell(
  r: UIResource,
  allButtons: UIButton[] | undefined,
  alertIndex: LogAlertIndex
): RowValues {
  let res = (r.status || {}) as UIResourceStatus
  let buildHistory = res.buildHistory || []
  let lastBuild = buildHistory.length > 0 ? buildHistory[0] : null
  let lastBuildDur =
    lastBuild?.startTime && lastBuild?.finishTime
      ? timeDiff(lastBuild.startTime, lastBuild.finishTime)
      : null
  let currentBuildStartTime = res.currentBuild?.startTime ?? ""
  let isBuilding = !isZeroTime(currentBuildStartTime)
  let hasBuilt = lastBuild !== null
  let buttons = buttonsForComponent(
    allButtons,
    ApiButtonType.Resource,
    r.metadata?.name
  )
  // Consider a resource `selectable` if it can be disabled
  const selectable = !!buttons.toggleDisable

  return {
    lastDeployTime: res.lastDeployTime ?? "",
    trigger: {
      isBuilding: isBuilding,
      hasBuilt: hasBuilt,
      hasPendingChanges: !!res.hasPendingChanges,
      isQueued: !!res.queued,
    },
    name: r.metadata?.name ?? "",
    resourceTypeLabel: resourceTypeLabel(r),
    statusLine: {
      buildStatus: buildStatus(r, alertIndex),
      buildAlertCount: buildAlerts(r, alertIndex).length,
      lastBuildDur: lastBuildDur,
      runtimeStatus: runtimeStatus(r, alertIndex),
      runtimeAlertCount: runtimeAlerts(r, alertIndex).length,
      hold: res.waiting ? new Hold(res.waiting) : null,
    },
    podId: res.k8sResourceInfo?.podName ?? "",
    endpoints: res.endpointLinks ?? [],
    mode: res.triggerMode ?? TriggerMode.TriggerModeAuto,
    buttons: buttons,
    selectable,
  }
}

function resourceTypeLabel(r: UIResource): string {
  let res = (r.status || {}) as UIResourceStatus
  let name = r.metadata?.name
  if (name == "(Tiltfile)") {
    return "Tiltfile"
  }
  let specs = res.specs ?? []
  for (let i = 0; i < specs.length; i++) {
    let spec = specs[i]
    if (spec.type === TargetType.K8s) {
      return "K8s"
    } else if (spec.type === TargetType.DockerCompose) {
      return "DCS"
    } else if (spec.type === TargetType.Local) {
      return "Local"
    }
  }
  return "Unknown"
}

function sortByDisableStatus(resources: UIResource[] = []) {
  // Sort by disabled status, so disabled resources appear at the end of each table list.
  // Note: this initial sort is done here so it doesn't interfere with the sorting
  // managed by react-table
  const sorted = [...resources].sort((a, b) => {
    const resourceAOrder = resourceIsDisabled(a) ? 1 : 0
    const resourceBOrder = resourceIsDisabled(b) ? 1 : 0

    return resourceAOrder - resourceBOrder
  })

  return sorted
}

function onlyEnabledRows(rows: RowValues[]): RowValues[] {
  return rows.filter(
    (row) => row.statusLine.runtimeStatus !== ResourceStatus.Disabled
  )
}
function onlyDisabledRows(rows: RowValues[]): RowValues[] {
  return rows.filter(
    (row) => row.statusLine.runtimeStatus === ResourceStatus.Disabled
  )
}
function enabledRowsFirst(rows: RowValues[]): RowValues[] {
  let result = onlyEnabledRows(rows)
  result.push(...onlyDisabledRows(rows))
  return result
}

export function labeledResourcesToTableCells(
  resources: UIResource[] | undefined,
  buttons: UIButton[] | undefined,
  logAlertIndex: LogAlertIndex
): GroupByLabelView<RowValues> {
  const labelsToResources: { [key: string]: RowValues[] } = {}
  const unlabeled: RowValues[] = []
  const tiltfile: RowValues[] = []

  if (resources === undefined) {
    return { labels: [], labelsToResources, tiltfile, unlabeled }
  }

  resources.forEach((r) => {
    const labels = getResourceLabels(r)
    const isTiltfile = r.metadata?.name === ResourceName.tiltfile
    const tableCell = uiResourceToCell(r, buttons, logAlertIndex)
    if (labels.length) {
      labels.forEach((label) => {
        if (!labelsToResources.hasOwnProperty(label)) {
          labelsToResources[label] = []
        }

        labelsToResources[label].push(tableCell)
      })
    } else if (isTiltfile) {
      tiltfile.push(tableCell)
    } else {
      unlabeled.push(tableCell)
    }
  })

  // Labels are always displayed in sorted order
  const labels = orderLabels(Object.keys(labelsToResources))

  return { labels, labelsToResources, tiltfile, unlabeled }
}

export function ResourceTableHeadRow({
  headerGroup,
  setGlobalSortBy,
}: ResourceTableHeadRowProps) {
  const calculateToggleProps = (column: HeaderGroup<RowValues>) => {
    // If a column header is JSX, fall back on using its id as a descriptive title
    // and capitalize for consistency
    const columnHeader =
      typeof column.Header === "string"
        ? column.Header
        : `${column.id[0]?.toUpperCase()}${column.id?.slice(1)}`

    // Warning! Toggle props are not typed or documented well within react-table.
    // Modify toggle props with caution.
    // See https://react-table.tanstack.com/docs/api/useSortBy#column-properties
    const toggleProps: { [key: string]: any } = {
      title: column.canSort ? `Sort by ${columnHeader}` : columnHeader,
    }

    if (setGlobalSortBy && column.canSort) {
      // The sort state is global whenever there are multiple tables, so
      // pass a click handler to the sort toggle that changes the global state
      toggleProps.onClick = () => setGlobalSortBy(column.id)
    }

    return toggleProps
  }

  const calculateHeaderProps = (column: HeaderGroup<RowValues>) => {
    const headerProps: Partial<TableHeaderProps> = {
      style: { width: column.width },
    }

    if (column.isSorted) {
      headerProps.className = "isSorted"
    }

    return headerProps
  }

  return (
    <ResourceTableRow className="isHeader" aria-rowindex={1}>
      {headerGroup.headers.map((column) => (
        <ResourceTableHeader
          {...column.getHeaderProps([
            calculateHeaderProps(column),
            column.getSortByToggleProps(calculateToggleProps(column)),
          ])}
        >
          <ResourceTableHeaderLabel>
            {column.render("Header")}
            <ResourceTableHeaderTip id={String(column.id)} />
            {column.canSort && (
              <ResourceTableHeaderSortTriangle
                className={
                  column.isSorted
                    ? column.isSortedDesc
                      ? "is-sorted-desc"
                      : "is-sorted-asc"
                    : ""
                }
              />
            )}
          </ResourceTableHeaderLabel>
        </ResourceTableHeader>
      ))}
    </ResourceTableRow>
  )
}

/**
 * Keeps native column associations present while grouped entries are virtualized.
 * The selection column is intentionally descriptive only: group actions belong
 * to the expanded group header below, never to every group in one operation.
 */
function GroupedSemanticHeaderRow(props: {
  headerGroup: HeaderGroup<RowValues>
}) {
  return (
    <ResourceTableRow className="isHeader" aria-rowindex={1}>
      {props.headerGroup.headers.map((column) => (
        <ResourceTableHeader as="th" scope="col" {...column.getHeaderProps()}>
          <ResourceTableHeaderLabel>
            {column.id === "selection"
              ? "Resource selection"
              : column.render("Header")}
          </ResourceTableHeaderLabel>
        </ResourceTableHeader>
      ))}
    </ResourceTableRow>
  )
}

/** Mirrors the one global react-table header inside an expanded group surface. */
function OverviewGroupHeaderRow(props: {
  headerGroup: HeaderGroup<RowValues>
  members: ReadonlyArray<Row<RowValues>>
  setGlobalSortBy: (id: string) => void
  ariaRowIndex: number
}) {
  const calculateToggleProps = (column: HeaderGroup<RowValues>) => {
    const columnHeader =
      typeof column.Header === "string"
        ? column.Header
        : `${column.id[0]?.toUpperCase()}${column.id?.slice(1)}`
    return {
      title: column.canSort ? `Sort by ${columnHeader}` : columnHeader,
      onClick: column.canSort
        ? () => props.setGlobalSortBy(column.id)
        : undefined,
    }
  }
  return (
    <ResourceTableRow className="isHeader" aria-rowindex={props.ariaRowIndex}>
      {props.headerGroup.headers.map((column) => (
        <OverviewGroupColumnHeader
          as="th"
          scope="col"
          {...column.getHeaderProps([
            { className: column.isSorted ? "isSorted" : "" },
            column.getSortByToggleProps(calculateToggleProps(column)),
          ])}
        >
          <ResourceTableHeaderLabel>
            {column.id === "selection" ? (
              <OverviewGroupSelection members={props.members} />
            ) : (
              column.render("Header")
            )}
            <ResourceTableHeaderTip id={String(column.id)} />
            {column.canSort && (
              <ResourceTableHeaderSortTriangle
                className={
                  column.isSorted
                    ? column.isSortedDesc
                      ? "is-sorted-desc"
                      : "is-sorted-asc"
                    : ""
                }
              />
            )}
          </ResourceTableHeaderLabel>
        </OverviewGroupColumnHeader>
      ))}
    </ResourceTableRow>
  )
}

/** A group action must use the logical members, never the mounted window. */
function OverviewGroupSelection(props: {
  members: ReadonlyArray<Row<RowValues>>
}) {
  const selection = useResourceSelection()
  const selectable = props.members
    .map((row) => row.original)
    .filter((row) => row.selectable)
    .map((row) => row.name)
  if (!selectable.length) return null
  const checked = selectable.every((name) => selection.isSelected(name))
  const indeterminate =
    !checked && selectable.some((name) => selection.isSelected(name))
  return (
    <SelectionCheckbox
      aria-label="Resource group selection"
      checked={checked}
      aria-checked={checked}
      indeterminate={indeterminate}
      onChange={() =>
        checked
          ? selection.deselect(...selectable)
          : selection.select(...selectable)
      }
      size="small"
    />
  )
}

type VirtualOverviewProps = {
  resources?: UIResource[]
  buttons?: UIButton[]
  grouped: boolean
  scrollOwner: HTMLElement
  contentOriginVersion: string
}

export function requireOverviewResource(
  resources: ReadonlyMap<string, UIResource>,
  name: string
): UIResource {
  if (!name.trim())
    throw new Error("Overview projection requires a non-empty resource name")
  const resource = resources.get(name)
  if (!resource)
    throw new Error(`Overview projection is missing resource ${name}`)
  return resource
}

export function requireOverviewEntryIndex(
  indices: ReadonlyMap<string, number>,
  key: string
): number {
  const index = indices.get(key)
  if (index === undefined)
    throw new Error(
      `Overview projection is missing logical entry index for ${key}`
    )
  return index
}

/**
 * The overview owns one react-table sort stream and projects that stream into
 * one immutable occurrence model. React-table only prepares rows that the
 * shared window actually mounts.
 */
function VirtualOverviewTable(props: VirtualOverviewProps) {
  const logAlertIndex = useLogAlertIndex()
  const { getGroup, toggleGroupExpanded } = useResourceGroups()
  const selection = useResourceSelection()
  const [sortState, setSortState] = useState<UseSortByState<RowValues>>()
  const [cursor, setCursor] =
    useState<
      import("./OverviewTableKeyboardShortcuts").OverviewOccurrenceCursor
    >()
  const [pending, setPending] =
    useState<
      import("./OverviewTableKeyboardShortcuts").OverviewOccurrenceCursor
    >()
  const contentOriginRef = useRef<HTMLTableSectionElement>(null)
  const rowsData = useMemo(
    () =>
      props.resources?.map((resource) =>
        uiResourceToCell(resource, props.buttons, logAlertIndex)
      ) ?? [],
    [logAlertIndex, props.buttons, props.resources]
  )
  const resourceByName = useMemo(
    () =>
      new Map(
        (props.resources ?? []).map((resource) => [
          resource.metadata?.name ?? "",
          resource,
        ])
      ),
    [props.resources]
  )
  const useControlledState = useCallback(
    (state: TableState<RowValues>) => ({ ...state, ...sortState }),
    [sortState]
  )
  const { getTableProps, headerGroups, rows, prepareRow } = useTable(
    {
      columns: COLUMNS,
      data: rowsData,
      autoResetSortBy: false,
      useControlledState,
    },
    useSortBy
  )
  const groupState = useMemo(() => {
    const state: Record<string, boolean> = {}
    rows.forEach((row) => {
      const resource = requireOverviewResource(
        resourceByName,
        row.original.name
      )
      getResourceLabels(resource).forEach(
        (label) => (state[label] = getGroup(label).expanded)
      )
    })
    state[UNLABELED_LABEL] = getGroup(UNLABELED_LABEL).expanded
    state[TILTFILE_LABEL] = getGroup(TILTFILE_LABEL).expanded
    return state
  }, [getGroup, resourceByName, rows])
  const model = useMemo(
    () =>
      buildSidebarVirtualModel<Row<RowValues>>({
        items: rows,
        isDisabled: rowIsDisabled,
        isTiltfile: (row) => row.original.name === ResourceName.tiltfile,
        labelsForItem: (row) =>
          getResourceLabels(
            requireOverviewResource(resourceByName, row.original.name)
          ),
        nameForItem: (row) => row.original.name,
        // The CSS footprint is intentionally uniform; the key remains a
        // single class only because all valid cells are clipped to one line.
        layoutKeyForItem: () => "overview-resource-row",
        sortLabels: orderLabels,
        groupState,
        grouped: props.grouped,
        partitionDisabled: false,
        expandSelectedGroup: false,
        groupCollapsible: () => true,
        groupHeaderLayoutKey: (group, expanded) => {
          // Collapsed groups omit their column band, while an expanded group
          // gains a selection control only when its complete logical members
          // contain a selectable resource. DOM mounting cannot decide this:
          // either variant may be the first header calibration.
          if (!expanded) return "overview-group-header-collapsed"
          return `overview-group-header-expanded-${
            group.members.some((row) => row.original.selectable)
              ? "selectable"
              : "text-only"
          }`
        },
      }),
    [groupState, props.grouped, resourceByName, rows]
  )
  useLayoutEffect(() => {
    setCursor((current) =>
      reconcileOverviewOccurrence(model.logicalResources, current)
    )
    setPending((current) =>
      reconcileOverviewOccurrence(model.logicalResources, current)
    )
  }, [model.logicalResources])
  const requestOccurrence = useCallback(
    (entry: ResourceVirtualResourceEntry<Row<RowValues>>) => {
      const group = model.groups.get(entry.groupId)
      flushSync(() => {
        if (group && !group.expanded) toggleGroupExpanded(group.label)
        const next = {
          occurrenceKey: entry.occurrenceKey,
          resourceName: entry.resourceName,
        }
        setCursor(next)
        setPending(next)
      })
    },
    [model.groups, toggleGroupExpanded]
  )
  const targetKey =
    pending &&
    model.entries.some(
      (entry) =>
        entry.kind === "resource" &&
        entry.occurrenceKey === pending.occurrenceKey
    )
      ? pending.occurrenceKey
      : undefined
  const setGlobalSortBy = (id: string) =>
    setSortState((current) => ({
      sortBy: calculateNextSort(id, current?.sortBy),
    }))
  const entryIndex = new Map(
    model.entries.map((entry, index) => [
      entry.kind === "resource"
        ? entry.occurrenceKey
        : entry.kind === "group-header"
        ? `group:${entry.groupId}`
        : `disabled:${entry.sectionId}`,
      index,
    ])
  )
  const ariaRowIndex = (entry: ResourceVirtualEntry<Row<RowValues>>) => {
    const key =
      entry.kind === "resource"
        ? entry.occurrenceKey
        : entry.kind === "group-header"
        ? `group:${entry.groupId}`
        : `disabled:${entry.sectionId}`
    const index = requireOverviewEntryIndex(entryIndex, key)
    if (!props.grouped) return index + 2
    return (
      2 +
      model.entries.slice(0, index).reduce((count, preceding) => {
        return (
          count +
          1 +
          (preceding.kind === "group-header" && preceding.expanded ? 1 : 0)
        )
      }, 0)
    )
  }
  const groupedAriaRowCount = model.entries.reduce(
    (count, entry) =>
      count + 1 + (entry.kind === "group-header" && entry.expanded ? 1 : 0),
    0
  )
  const renderEntry = (
    entry: ResourceVirtualEntry<Row<RowValues>>,
    onElement: (element: HTMLElement | null) => void
  ) => {
    const entryKey =
      entry.kind === "resource"
        ? entry.occurrenceKey
        : entry.kind === "group-header"
        ? `group:${entry.groupId}`
        : `disabled:${entry.sectionId}`
    const index = requireOverviewEntryIndex(entryIndex, entryKey)
    if (entry.kind === "resource") {
      const row = entry.item
      const group = model.groups.get(entry.groupId)
      if (!group)
        throw new Error(
          `Overview projection is missing group ${entry.groupId} for ${entry.occurrenceKey}`
        )
      prepareRow(row)
      const focused = cursor?.occurrenceKey === entry.occurrenceKey
      const classes =
        "isResource " +
        "isOverviewPanelResource " +
        (entry.groupIndex === group.members.length - 1
          ? "isOverviewPanelLastResource isOverviewGroupLastResource "
          : "") +
        (rowIsDisabled(row) ? "isDisabled " : "") +
        (selection.isSelected(row.original.name) ? "isSelected " : "") +
        (focused ? "isFocused " : "")
      return (
        <ResourceTableRow
          {...row.getRowProps({ className: classes })}
          id={`overview-resource-${encodeURIComponent(entry.occurrenceKey)}`}
          data-occurrence-key={entry.occurrenceKey}
          aria-rowindex={ariaRowIndex(entry)}
          tabIndex={-1}
          ref={onElement as React.Ref<HTMLTableRowElement>}
        >
          {row.cells.map((cell) => (
            <ResourceTableData
              {...cell.getCellProps()}
              className={cell.column.isSorted ? "isSorted" : ""}
            >
              {cell.render("Cell")}
            </ResourceTableData>
          ))}
        </ResourceTableRow>
      )
    }
    if (entry.kind === "group-header") {
      const label =
        entry.label === UNLABELED_LABEL ? <em>{entry.label}</em> : entry.label
      return (
        <tbody
          ref={onElement as React.Ref<HTMLTableSectionElement>}
          data-overview-group-header={entry.groupId}
          className={`overviewGroupHeaderBody ${
            entry.expanded ? "isExpanded" : "isCollapsed"
          }`}
        >
          <tr aria-hidden="true">
            <OverviewGroupSpacerCell
              className="overviewGroupSpacerCell"
              colSpan={COLUMNS.length}
              aria-hidden="true"
            />
          </tr>
          <ResourceTableRow
            aria-rowindex={ariaRowIndex(entry)}
            data-group-id={entry.groupId}
          >
            <ResourceTableData
              className="overviewGroupHeaderCell"
              colSpan={COLUMNS.length}
            >
              <OverviewGroupSummary
                className="overviewGroupSummary"
                id={`overview-group-control-${encodeURIComponent(
                  entry.groupId
                )}`}
                role="button"
                tabIndex={0}
                aria-expanded={entry.expanded}
                aria-controls={`overview-group-${encodeURIComponent(
                  entry.groupId
                )}`}
                onClick={() => toggleGroupExpanded(entry.label)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return
                  event.preventDefault()
                  toggleGroupExpanded(entry.label)
                }}
              >
                <ResourceGroupSummaryIcon role="presentation" />
                <OverviewGroupName className="overviewGroupName">
                  {label}
                </OverviewGroupName>
                <TableGroupStatusSummary
                  labelText={`Status summary for ${entry.label} group`}
                  resources={[...entry.members].map((row) => row.original)}
                />
              </OverviewGroupSummary>
            </ResourceTableData>
          </ResourceTableRow>
          {entry.expanded && (
            <OverviewGroupHeaderRow
              headerGroup={headerGroups[0]}
              members={entry.members}
              setGlobalSortBy={setGlobalSortBy}
              ariaRowIndex={ariaRowIndex(entry) + 1}
            />
          )}
        </tbody>
      )
    }
    throw new Error(
      `Overview projection cannot render disabled-header ${entry.sectionId}; partitionDisabled must remain false`
    )
  }
  const renderEntries = (
    entries: ReadonlyArray<ResourceVirtualEntry<Row<RowValues>>>,
    render: (
      entry: ResourceVirtualEntry<Row<RowValues>>,
      onElement: (element: HTMLElement | null) => void
    ) => React.ReactNode
  ) => {
    const groups: Array<{
      groupId: string
      group: ResourceVirtualGroup<Row<RowValues>>
      entries: ResourceVirtualEntry<Row<RowValues>>[]
    }> = []
    entries.forEach((entry) => {
      const groupId = entry.groupId
      const modelGroup = model.groups.get(groupId)
      if (!modelGroup)
        throw new Error(
          `Overview projection is missing group ${groupId} while rendering its rowgroup`
        )
      const previous = groups[groups.length - 1]
      if (!previous || previous.groupId !== groupId)
        groups.push({ groupId, group: modelGroup, entries: [entry] })
      else previous.entries.push(entry)
    })
    return groups.map((group) => {
      const header = group.entries.find(
        (
          entry
        ): entry is ResourceVirtualEntry<Row<RowValues>> & {
          kind: "group-header"
        } => entry.kind === "group-header"
      )
      const resources = group.entries.filter(
        (entry): entry is ResourceVirtualResourceEntry<Row<RowValues>> =>
          entry.kind === "resource"
      )
      return (
        <React.Fragment key={group.groupId}>
          {header && render(header, () => {})}
          {(header || resources.length > 0) && (
            <tbody
              id={`overview-group-${encodeURIComponent(group.groupId)}`}
              role="rowgroup"
              aria-label={
                props.grouped ? `${group.group.label} resources` : "Resources"
              }
              className={
                props.grouped
                  ? `overviewGroupBody ${
                      group.group.expanded ? "isExpanded" : "isCollapsed"
                    }`
                  : "overviewUngroupedBody"
              }
            >
              {resources.map((entry) => (
                <React.Fragment key={entry.occurrenceKey}>
                  {render(entry, () => {})}
                </React.Fragment>
              ))}
            </tbody>
          )}
        </React.Fragment>
      )
    })
  }
  return (
    <ResourceTable
      {...getTableProps()}
      className={props.grouped ? undefined : "isUngroupedOverview"}
      aria-rowcount={
        props.grouped ? groupedAriaRowCount + 1 : model.entries.length + 1
      }
    >
      <colgroup>
        {headerGroups[0].headers.map((column) => (
          <col key={column.id} style={{ width: column.width }} />
        ))}
      </colgroup>
      {props.grouped ? (
        <GroupedResourceTableHead>
          <GroupedSemanticHeaderRow headerGroup={headerGroups[0]} />
        </GroupedResourceTableHead>
      ) : (
        <ResourceTableHead>
          {headerGroups.map((headerGroup) => (
            <ResourceTableHeadRow
              {...headerGroup.getHeaderGroupProps()}
              headerGroup={headerGroup}
              setGlobalSortBy={setGlobalSortBy}
            />
          ))}
        </ResourceTableHead>
      )}
      <tbody ref={contentOriginRef} aria-hidden="true">
        <tr>
          <VirtualSpacerCell colSpan={COLUMNS.length} style={{ height: 0 }} />
        </tr>
      </tbody>
      <ResourceVirtualWindow
        entries={model.entries}
        scrollOwnerRef={{ current: props.scrollOwner }}
        contentOriginRef={contentOriginRef}
        contentOriginVersion={`${props.contentOriginVersion}:${props.grouped}:${model.entries.length}`}
        targetKey={targetKey}
        onTargetMounted={(key, element) => {
          if (key !== pending?.occurrenceKey) return
          element.focus()
          setPending((current) =>
            current?.occurrenceKey === key ? undefined : current
          )
        }}
        asFragment
        renderEntries={renderEntries}
        renderEntry={renderEntry}
        renderSpacer={(height, position) => (
          <tbody aria-hidden="true" data-virtual-spacer={position}>
            <tr>
              <VirtualSpacerCell colSpan={COLUMNS.length} style={{ height }} />
            </tr>
          </tbody>
        )}
      />
      <OverviewTableKeyboardShortcuts
        items={model.logicalResources}
        cursor={pending ?? cursor}
        onRequestOccurrence={requestOccurrence}
      />
    </ResourceTable>
  )
}

function OverviewTableContent(
  props: OverviewTableProps & { scrollOwner?: HTMLElement }
) {
  const features = useFeatures()
  const labelsEnabled = features.isEnabled(Flag.Labels)
  const resourcesHaveLabels =
    props.view.uiResources?.some((r) => getResourceLabels(r).length > 0) ||
    false

  const { options } = useResourceListOptions()
  const resourceFilterApplied = options.resourceNameFilter.length > 0

  // Apply any display filters or options to resources, plus sort for initial view
  const resourcesToDisplay = applyOptionsToResources(
    props.view.uiResources,
    options,
    features
  )

  // Table groups are displayed when feature is enabled, resources have labels,
  // and no resource name filter is applied
  const displayResourceGroups =
    labelsEnabled && resourcesHaveLabels && !resourceFilterApplied

  if (props.scrollOwner) {
    return (
      <>
        {!displayResourceGroups && labelsEnabled && !resourcesHaveLabels && (
          <ResourceGroupsInfoTip idForIcon={GROUP_INFO_TOOLTIP_ID} />
        )}
        {!displayResourceGroups && (
          <>
            <TableResourceResultCount resources={resourcesToDisplay} />
            <TableNoMatchesFound resources={resourcesToDisplay} />
          </>
        )}
        {resourcesToDisplay.length > 0 && (
          <VirtualOverviewTable
            resources={resourcesToDisplay}
            buttons={props.view.uiButtons}
            grouped={displayResourceGroups}
            scrollOwner={props.scrollOwner}
            contentOriginVersion={`${resourceFilterApplied}:${resourcesToDisplay.length}`}
          />
        )}
      </>
    )
  }
  // The parent ref commits before this state update; never render a
  // pre-window fallback that could briefly materialize every occurrence.
  return null
}

export default function OverviewTable(props: OverviewTableProps) {
  const [ownerElement, setOwnerElement] = useState<HTMLElement>()
  const setOwner = useCallback((element: HTMLElement | null) => {
    setOwnerElement(element ?? undefined)
  }, [])
  return (
    <OverviewTableRoot aria-label="Resources overview" ref={setOwner}>
      <OverviewTableContentRoot>
        <OverviewTableContent {...props} scrollOwner={ownerElement} />
      </OverviewTableContentRoot>
    </OverviewTableRoot>
  )
}
