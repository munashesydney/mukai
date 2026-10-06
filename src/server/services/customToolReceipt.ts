import type { CustomToolReceipt } from '../../shared/customCapabilities';

/** Keep runtime evidence separate from arbitrary, untrusted custom tool output. */
export function customToolReceipt(
  permission: CustomToolReceipt['permission'],
  execution: CustomToolReceipt['execution'],
  details: Omit<CustomToolReceipt, 'permission' | 'execution'> = {},
): CustomToolReceipt {
  return { permission, execution, ...details };
}
