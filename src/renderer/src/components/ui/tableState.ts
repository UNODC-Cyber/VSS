import { create } from 'zustand';

/**
 * Session state of the data tables: which columns the user hid in this session, per table id. It is deliberately
 * not persisted by the table itself (browser storage is cleared on lock); the user stores it with
 * Settings > Appearance > "Remember current columns", which writes it to `Settings.tableColumns`.
 */
interface TableState {
  hidden: Record<string, string[]>;
  setHidden: (tableId: string, ids: string[]) => void;
  reset: () => void;
}

export const useTableState = create<TableState>((set) => ({
  hidden: {},
  setHidden: (tableId, ids) => set((s) => ({ hidden: { ...s.hidden, [tableId]: ids } })),
  reset: () => set({ hidden: {} }),
}));
