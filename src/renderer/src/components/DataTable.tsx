import { ActionIcon, Checkbox, Popover, Stack, Table, Text, Tooltip } from '@mantine/core';
import { FlexRender, tableFeatures, useTable } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useUi } from '../store';
import { IconColumns3, IconTableOff } from './ui/icons';
import { useTableState } from './ui/tableState';

const features = tableFeatures({});
export type VssFeatures = typeof features;

/**
 * Layout metadata of a column (docs/PLAN-ALPHA.md section 9). Widths are CSS pixels. A table where at least one
 * column carries meta uses `table-layout: fixed` inside a horizontal scroll region, so columns can never overlap.
 */
export interface ColMeta<T extends object = object> {
  /** Fixed width. Without it the column is `maxWidth`, else `minWidth`, else 120. */
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  /** Takes the space left over when the table is wider than the sum of the column widths. */
  grow?: boolean;
  /** Cell content is one line cut with an ellipsis; the full text shows in a tooltip on hover and focus when cut. */
  truncate?: boolean;
  /** Cell content never wraps (dates, status badges). */
  nowrap?: boolean;
  /** Text of the tooltip of a truncated cell; defaults to the cell's own text. */
  tooltip?: (row: T) => string | null | undefined;
  /** Pinned to the left edge while scrolling horizontally (first column only). */
  sticky?: 'first';
  align?: 'left' | 'right' | 'center';
  /** Appears in the column chooser; the user may hide it. */
  hideable?: boolean;
  /** Hidden until the user shows it (only with `hideable`). */
  defaultHidden?: boolean;
}

export type Col<T extends object> = ColumnDef<VssFeatures, T> & { meta?: ColMeta<T> };

/** Display column: header text and a render function over the row. `meta` opts the column into the v2 layout. */
export function col<T extends object>(
  id: string,
  header: string,
  cell: (row: T) => ReactNode,
  meta?: ColMeta<T>,
): Col<T> {
  return { id, header, cell: (ctx) => cell(ctx.row.original), ...(meta ? { meta } : {}) } as Col<T>;
}

interface Props<T extends object> {
  columns: Col<T>[];
  data: T[];
  caption: string;
  rowId?: (row: T) => string;
  rowProps?: (row: T) => Record<string, string | number | undefined>;
  empty?: string;
  /** Second line of the empty state. */
  emptyHint?: string;
  emptyIcon?: ReactNode;
  /** Stable id; enables the saved/session column choice (`Settings.tableColumns[tableId]`). */
  tableId?: string;
  /** Bounds the height so the header stays visible while rows scroll. */
  maxHeight?: number;
}

const DEFAULT_WIDTH = 120;
export const colWidth = (m: ColMeta<never> | undefined): number =>
  m?.width ?? m?.maxWidth ?? m?.minWidth ?? DEFAULT_WIDTH;
const colMin = (m: ColMeta<never> | undefined): number => m?.minWidth ?? colWidth(m);

/** Class names a cell carries; exported so tests can assert the configuration without a layout engine. */
export function cellClass(m: ColMeta<never> | undefined, isFirst: boolean): string {
  return [
    'vss-cell',
    m?.nowrap || m?.width ? 'vss-nowrap' : '',
    m?.truncate ? 'vss-truncate' : '',
    m?.sticky === 'first' && isFirst ? 'vss-sticky' : '',
    m?.align ? `vss-align-${m.align}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Cells are called as plain functions, NOT through FlexRender: FlexRender mounts function cells as components, and
 * our cell closures change every render, which would remount (and drop focus from) inputs inside cells.
 */
function renderCell(c: { column: { columnDef: { cell?: unknown } }; getContext(): unknown }): ReactNode {
  const fn = c.column.columnDef.cell;
  return typeof fn === 'function' ? (fn(c.getContext()) as ReactNode) : (fn as ReactNode);
}

/** One-line cell with an ellipsis. The tooltip is active only while the content is actually cut. */
function TruncatedCell({ children, full }: { children: ReactNode; full: string | null | undefined }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const [text, setText] = useState('');
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      setCut(el.scrollWidth > el.clientWidth + 1);
      setText(el.textContent ?? '');
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
  const label = full ?? text;
  return (
    <Tooltip label={label} disabled={!cut || !label} multiline maw={420} openDelay={200}>
      <span
        ref={ref}
        className="vss-truncate-inner"
        data-full={label || undefined}
        tabIndex={cut ? 0 : undefined}
        aria-label={cut && label ? label : undefined}
      >
        {children}
      </span>
    </Tooltip>
  );
}

function ColumnChooser({
  tableId,
  items,
  hidden,
  onChange,
}: {
  tableId: string;
  items: { id: string; header: string }[];
  hidden: string[];
  onChange: (hidden: string[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <Popover position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <ActionIcon variant="default" aria-label={t('ui.table.chooseColumns')} title={t('ui.table.chooseColumns')}>
          <IconColumns3 size={18} aria-hidden="true" />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs" role="group" aria-label={t('ui.table.chooseColumns')}>
          {items.map((c) => (
            <Checkbox
              key={c.id}
              id={`vss-col-${tableId}-${c.id}`}
              label={c.header}
              checked={!hidden.includes(c.id)}
              onChange={(e) => onChange(e.currentTarget.checked ? hidden.filter((h) => h !== c.id) : [...hidden, c.id])}
            />
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/**
 * Mantine table over TanStack Table v9 (no client features; paging and sorting are server side).
 * Without any column meta it renders exactly as before (auto layout). With meta it is a fixed-layout grid in a keyboard
 * scrollable region: per-column width, truncation with tooltip, no-wrap, pinned first column, column chooser, density.
 */
export function DataTable<T extends object>({
  columns,
  data,
  caption,
  rowId,
  rowProps,
  empty,
  emptyHint,
  emptyIcon,
  tableId,
  maxHeight,
}: Props<T>) {
  const density = useUi((s) => s.settings.uiDensity);
  const savedHidden = useUi((s) => (tableId ? s.settings.tableColumns[tableId] : undefined));
  const sessionHidden = useTableState((s) => (tableId ? s.hidden[tableId] : undefined));
  const setSessionHidden = useTableState((s) => s.setHidden);

  const metaOf = (c: Col<T>): ColMeta<T> | undefined => c.meta;
  const engine = columns.some((c) => metaOf(c) !== undefined);
  const defaultHidden = useMemo(
    () => columns.filter((c) => metaOf(c)?.hideable && metaOf(c)?.defaultHidden).map((c) => String(c.id)),
    [columns],
  );
  const hidden = sessionHidden ?? savedHidden ?? defaultHidden;
  const hideableCols = columns.filter((c) => metaOf(c)?.hideable);
  const visible = columns.filter((c) => !(metaOf(c)?.hideable && hidden.includes(String(c.id))));

  const table = useTable({
    features,
    columns: visible,
    data,
    ...(rowId ? { getRowId: (r: T) => rowId(r) } : {}),
  });
  const rows = table.getRowModel().rows;
  const metaById = new Map(visible.map((c) => [String(c.id), metaOf(c)]));

  const totalMin = visible.reduce((n, c) => n + colMin(metaOf(c)), 0);
  const hasGrow = visible.some((c) => metaOf(c)?.grow);
  const tableStyle: CSSProperties | undefined = engine
    ? {
        tableLayout: 'fixed',
        minWidth: totalMin,
        width: hasGrow ? '100%' : visible.reduce((n, c) => n + colWidth(metaOf(c)), 0),
      }
    : undefined;
  const density_ = density === 'compact' ? 'xs' : 'sm';

  const body = (
    <Table
      striped
      highlightOnHover
      withTableBorder
      verticalSpacing={density_}
      stickyHeader={maxHeight !== undefined}
      data-density={density}
      data-layout={engine ? 'fixed' : 'auto'}
      className={engine ? 'vss-table' : undefined}
      style={tableStyle}
    >
      {engine && (
        <colgroup>
          {visible.map((c) => {
            const m = metaOf(c);
            return <col key={String(c.id)} style={m?.grow ? { minWidth: colMin(m) } : { width: colWidth(m) }} />;
          })}
        </colgroup>
      )}
      <Table.Caption>{caption}</Table.Caption>
      <Table.Thead>
        {table.getHeaderGroups().map((hg) => (
          <Table.Tr key={hg.id}>
            {hg.headers.map((h, i) => {
              const m = metaById.get(h.id);
              return (
                <Table.Th key={h.id} scope="col" className={engine ? cellClass(m, i === 0) : undefined}>
                  {h.isPlaceholder ? null : <FlexRender header={h} />}
                </Table.Th>
              );
            })}
          </Table.Tr>
        ))}
      </Table.Thead>
      <Table.Tbody>
        {rows.length === 0 ? (
          <Table.Tr>
            <Table.Td colSpan={Math.max(1, visible.length)}>
              {emptyIcon === undefined && !emptyHint ? (
                (empty ?? '')
              ) : (
                <Stack align="center" gap={4} py="md" data-testid="table-empty">
                  {emptyIcon ?? <IconTableOff size={28} aria-hidden="true" />}
                  <Text fw={500}>{empty ?? ''}</Text>
                  {emptyHint && (
                    <Text size="sm" c="dimmed">
                      {emptyHint}
                    </Text>
                  )}
                </Stack>
              )}
            </Table.Td>
          </Table.Tr>
        ) : (
          rows.map((r) => {
            const original = r.original;
            return (
              <Table.Tr key={r.id} {...(rowProps ? rowProps(original) : {})}>
                {r.getAllCells().map((c, i) => {
                  const m = metaById.get(c.column.id);
                  const content = renderCell(c);
                  const cls = engine ? cellClass(m, i === 0) : undefined;
                  const wrapped =
                    m?.truncate && engine ? (
                      <TruncatedCell full={m.tooltip ? m.tooltip(original) : undefined}>{content}</TruncatedCell>
                    ) : (
                      content
                    );
                  return (
                    <Table.Td key={c.id} className={cls}>
                      {wrapped}
                    </Table.Td>
                  );
                })}
              </Table.Tr>
            );
          })
        )}
      </Table.Tbody>
    </Table>
  );

  if (!engine) {
    return <Table.ScrollContainer minWidth={600}>{body}</Table.ScrollContainer>;
  }
  return (
    <div className="vss-table-wrap" data-table-id={tableId}>
      {tableId && hideableCols.length > 0 && (
        <div className="vss-table-tools">
          <ColumnChooser
            tableId={tableId}
            items={hideableCols.map((c) => ({ id: String(c.id), header: String(c.header ?? c.id) }))}
            hidden={hidden}
            onChange={(next) => setSessionHidden(tableId, next)}
          />
        </div>
      )}
      <div
        className="vss-table-scroll"
        role="region"
        aria-label={caption}
        tabIndex={0}
        style={maxHeight !== undefined ? { maxHeight } : undefined}
      >
        {body}
      </div>
    </div>
  );
}
