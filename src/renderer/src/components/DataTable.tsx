import { Table } from '@mantine/core';
import { FlexRender, tableFeatures, useTable } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import type { ReactNode } from 'react';

const features = tableFeatures({});
export type VssFeatures = typeof features;
export type Col<T extends object> = ColumnDef<VssFeatures, T>;

/** Display column: header text and a render function over the row. */
export function col<T extends object>(id: string, header: string, cell: (row: T) => ReactNode): Col<T> {
  return { id, header, cell: (ctx) => cell(ctx.row.original) } as Col<T>;
}

interface Props<T extends object> {
  columns: Col<T>[];
  data: T[];
  caption: string;
  rowId?: (row: T) => string;
  rowProps?: (row: T) => Record<string, string | number | undefined>;
  empty?: string;
}

/**
 * Cells are called as plain functions, NOT through FlexRender: FlexRender mounts function cells as components, and
 * our cell closures change every render, which would remount (and drop focus from) inputs inside cells.
 */
function renderCell(c: { column: { columnDef: { cell?: unknown } }; getContext(): unknown }): ReactNode {
  const fn = c.column.columnDef.cell;
  return typeof fn === 'function' ? (fn(c.getContext()) as ReactNode) : (fn as ReactNode);
}

/** Thin Mantine table over TanStack Table v9 (no client features; paging and sorting are server side). */
export function DataTable<T extends object>({ columns, data, caption, rowId, rowProps, empty }: Props<T>) {
  const table = useTable({
    features,
    columns,
    data,
    ...(rowId ? { getRowId: (r: T) => rowId(r) } : {}),
  });
  const rows = table.getRowModel().rows;
  return (
    <Table.ScrollContainer minWidth={600}>
      <Table striped highlightOnHover withTableBorder>
        <Table.Caption>{caption}</Table.Caption>
        <Table.Thead>
          {table.getHeaderGroups().map((hg) => (
            <Table.Tr key={hg.id}>
              {hg.headers.map((h) => (
                <Table.Th key={h.id} scope="col">
                  {h.isPlaceholder ? null : <FlexRender header={h} />}
                </Table.Th>
              ))}
            </Table.Tr>
          ))}
        </Table.Thead>
        <Table.Tbody>
          {rows.length === 0 ? (
            <Table.Tr>
              <Table.Td colSpan={columns.length}>{empty ?? ''}</Table.Td>
            </Table.Tr>
          ) : (
            rows.map((r) => (
              <Table.Tr key={r.id} {...(rowProps ? rowProps(r.original) : {})}>
                {r.getAllCells().map((c) => (
                  <Table.Td key={c.id}>{renderCell(c)}</Table.Td>
                ))}
              </Table.Tr>
            ))
          )}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
