export interface ExtensionCapabilities {
  runtime?: {
    getContexts?: (...args: any[]) => unknown;
    getURL?: (path: string) => string;
  };
  offscreen?: {
    createDocument?: (...args: any[]) => unknown;
    closeDocument?: (...args: any[]) => unknown;
  };
  tabCapture?: {
    getMediaStreamId?: (...args: any[]) => unknown;
  };
  sidePanel?: {
    open?: (options: { tabId: number }) => Promise<unknown>;
  };
  sidebarAction?: {
    open?: () => Promise<unknown>;
  };
  tabs?: {
    create?: (options: { url: string; active: boolean }) => unknown;
  };
}

export function supportsLiveCapture(api: ExtensionCapabilities): boolean {
  return typeof api.runtime?.getContexts === 'function'
    && typeof api.offscreen?.createDocument === 'function'
    && typeof api.offscreen?.closeDocument === 'function'
    && typeof api.tabCapture?.getMediaStreamId === 'function';
}

export async function openComparisonSurface(
  api: ExtensionCapabilities,
  tabId?: number,
): Promise<'side-panel' | 'sidebar' | 'tab'> {
  if (tabId !== undefined && typeof api.sidePanel?.open === 'function') {
    try {
      await api.sidePanel.open({ tabId });
      return 'side-panel';
    } catch {
      // Fall through to another supported comparison surface.
    }
  }

  if (typeof api.sidebarAction?.open === 'function') {
    try {
      await api.sidebarAction.open();
      return 'sidebar';
    } catch {
      // Fall through to a regular extension tab.
    }
  }

  if (typeof api.tabs?.create !== 'function' || typeof api.runtime?.getURL !== 'function') {
    throw new Error('This browser cannot open the comparison view.');
  }
  api.tabs.create({ url: api.runtime.getURL('sidepanel.html'), active: true });
  return 'tab';
}
