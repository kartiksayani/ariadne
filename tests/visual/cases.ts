// Reference sheets 1j/1k/1s stay in the existing gallery; these cases use
// the ordinary DesktopApp and canonical domain snapshots behind its real stores.
export const ordinaryCases = [
  { id: '1a', item: '2', rail: true }, { id: '1b', item: '6', rail: true },
  { id: '1c', item: '2', action: 'answer' }, { id: '1d', item: '1', graph: true },
  { id: '1e', item: '2' }, { id: '1f', item: '2', graph: true, rail: true },
  { id: '1g', empty: true }, { id: '1h', loading: true }, { id: '1i', clear: true },
  { id: '1l', item: '2', answered: true }, { id: '1m', item: '1', rail: true },
  { id: '1n', item: '2', filtered: true }, { id: '1o', item: '2', disconnected: true },
  { id: '1p', navigation: 'projects' }, { id: '1q', item: '4' },
  { id: '1r', item: '4', action: 'reply' }, { id: '1t', item: '2', multiple: true, rail: true },
  { id: '1u', item: '1' }, { id: '1v', item: '1', action: 'followup' },
  { id: '1w', item: '8' }, { id: '1x', archived: true },
  { id: '1y', item: '1', action: 'continue' }, { id: '1z', navigation: 'all_sessions' },
  { id: '1aa', graph: true, disconnected: true }, { id: '1ab', navigation: 'projects' },
  { id: '1ac', navigation: 'project' }, { id: '1ad', item: '2', disconnected: true },
] as const;
export type OrdinaryCase = { id: string; item?: string; rail?: boolean; graph?: boolean; action?: string; empty?: boolean;
  loading?: boolean; clear?: boolean; answered?: boolean; filtered?: boolean; disconnected?: boolean;
  navigation?: string; multiple?: boolean; archived?: boolean };
