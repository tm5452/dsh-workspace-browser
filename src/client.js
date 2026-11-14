const { createElement: h, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = react;
const {
  Button, MenuItemButton, StateDot, IconCheckOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular, IconFolderOpenRegular,
  IconPinFillRegular, IconFlatListOutlineRegular, IconArchiveOutlineRegular, IconClockOutlineRegular,
} = ui;

const inject = ['slots', 'locale', 'workspaces', 'sessions', 'uiSession', 'uiWorkspace', 'layout', 'remote', 'remote.schedule'];
const ungrouped = '';
const defaultOptions = {};
const emptyView = { getSnapshot: () => defaultOptions, subscribe: () => () => {} };
const preferenceKey = `${id}.sidebar`;
const unreadKey = preferenceKey + '.unread';
const emptyOrder = {};
const emptySchedule = { records: [] };
function scheduleSourceFor(ctx) {
  let snapshot = emptySchedule;
  let revision = 0;
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      async function refresh() {
        const request = ++revision;
        try {
          const result = await ctx.remote.schedule.catalog();
          if (request !== revision || !result.ok) return;
          snapshot = { records: result.value };
          listener();
        } catch {
          // A later catalog change or reconnect retries the read.
        }
      }
      const stopChanged = ctx.remote.$on('schedule/changed', refresh);
      const stopReset = ctx.on('connection/reset', refresh);
      refresh();
      return () => {
        revision++;
        stopChanged();
        stopReset();
      };
    },
  };
}
const folderKey = key => 'folder:' + key;
const sessionKey = key => 'session:' + key;
const pageKey = folder => folder === null ? 'home' : folderKey(folder);

// The native new-session button carries no stable attribute, so it is recognised
// by its own new-chat glyph or by a shortcut, minus the sidebar toggles and
// everything inside the workspaces region (add workspace also has a shortcut).
function isNewSessionButton(button) {
  if (!button || button.disabled) return false;
  if (button.closest('[data-sidebar-toggle], [data-sidebar-opener], [data-slot="sidebar.workspaces"]')) return false;
  return Boolean(button.querySelector('[data-icon^="dsw-icon-new-chat"]')) || button.hasAttribute('aria-keyshortcuts');
}

function getNewSessionButton(event) {
  const button = event.target instanceof Element ? event.target.closest('button') : null;
  return isNewSessionButton(button) && button.closest('[data-slot="sidebar"]') ? button : null;
}

const dictionaries = {
  zh: {
    panel: '文件夹浏览', home: '主页', path: '工作区路径', back: '后退', forward: '前进', up: '上一级',
    ungrouped: '未分组会话', locate: '回到当前会话', createError: '暂时无法新建会话。',
    loading: '正在加载…', loadError: '暂时无法读取工作区。', openError: '暂时无法打开此会话。',
    emptyHome: '还没有工作区。', emptyFolder: '此工作区没有子工作区或会话。', noArchives: '没有已归档会话。',
    archived: '已归档会话', scheduled: '有定时任务', running: '运行中', oneRunningSession: '1 个会话运行中', runningSessions: '{n} 个会话运行中',
    gestureUp: '返回上一级', gestureInvalid: '无效手势',
    display: '视图选项', icons: '大图标', list: '列表', resize: '调整工作区分隔位置',
  },
  en: {
    panel: 'Browse folders', home: 'Home', path: 'Workspace path', back: 'Back', forward: 'Forward', up: 'Up one level',
    ungrouped: 'Ungrouped sessions', locate: 'Go to current session', createError: 'Could not start a new session.',
    loading: 'Loading…', loadError: 'Could not load workspaces.', openError: 'Could not open this session.',
    emptyHome: 'No workspaces yet.', emptyFolder: 'No child workspaces or sessions in this workspace.',
    noArchives: 'No archived sessions.', archived: 'Archived session', scheduled: 'Has scheduled tasks', running: 'Running',
    runningSessions: '{n} sessions running', oneRunningSession: '1 session running',
    gestureUp: 'Up one level', gestureInvalid: 'Invalid gesture',
    display: 'View options', icons: 'Large icons', list: 'List', resize: 'Resize workspace area',
  },
};

function workspacePath(path) {
  const windows = /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\');
  const normalized = (windows ? path.replaceAll('\\', '/') : path).replace(/\/+$/, '');
  return { normalized, folded: windows ? normalized.toLowerCase() : undefined };
}

function workspaceTree(items) {
  const byId = new Map(items.map(item => [item.workspaceId, item]));
  const paths = new Map(items.map(item => [item.path, item.workspaceId]));
  const folders = [...paths].map(([path, id]) => ({ ...workspacePath(path), id }));
  const parents = new Map();
  const children = new Map();
  for (const item of items) {
    const child = workspacePath(item.path);
    let parent = null;
    let length = -1;
    let exactParent = false;
    for (const folder of folders) {
      if (folder.normalized.length >= child.normalized.length || folder.normalized.length < length) continue;
      const exact = child.normalized.startsWith(`${folder.normalized}/`);
      const folded = folder.folded !== undefined && child.folded?.startsWith(`${folder.folded}/`);
      if ((!exact && !folded) || (folder.normalized.length === length && (exactParent || !exact))) continue;
      parent = folder.id;
      length = folder.normalized.length;
      exactParent = exact;
    }
    parents.set(item.workspaceId, parent);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  }
  return { byId, parents, children };
}

function sessionRows(workspaceState, sessions, options) {
  const { byId, ids } = sessions;
  const archived = new Set(workspaceState.archivedSessionIds);
  const pinned = new Set(workspaceState.pinnedSessionIds);
  const assigned = new Set(workspaceState.items.flatMap(workspace => workspace.sessionIds));
  const filter = options.archivedFilter ?? 'default';
  const visible = session => session && session.origin !== 'subagent' && (!session.blank || session.retainedBy?.mainView > 0)
    && (filter === 'show' || (filter === 'only') === archived.has(session.id));
  const sorted = (members, account) => {
    const manual = options.orderBy === 'manual';
    const order = new Map((manual ? options.sessionOrderByAccount?.[account] ?? [] : []).map((id, index) => [id, index]));
    const rank = session => session.blank ? 0 : pinned.has(session.id) && !archived.has(session.id) ? 1 : 2;
    return members.map(id => byId[id]).filter(visible).sort((a, b) => rank(a) - rank(b)
      || (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity)
      || (manual ? Number(archived.has(a.id)) - Number(archived.has(b.id)) : 0)
      || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };
  const byWorkspace = new Map(workspaceState.items.map(workspace => [workspace.workspaceId, sorted(workspace.sessionIds, workspace.workspaceId)]));
  byWorkspace.set(ungrouped, sorted(ids.filter(id => !assigned.has(id)), ungrouped));
  return { byWorkspace, pinned, archived };
}

const statusDetails = {
  approval: { state: 'error', label: 'status.waitingApproval', priority: 3 },
  question: { state: 'warning', label: 'status.waitingAnswer', priority: 2 },
  'plan-review': { state: 'warning', label: 'status.planReview', priority: 2 },
  completed: { state: 'done', label: 'status.completed', priority: 1 },
};

function completionSource(ctx) {
  const list = ctx.sessions.list;
  const status = ctx.uiSession.sessionStatus;
  const panel = ctx.layout.panelInfo;
  const listeners = new Set();
  let unread = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(unreadKey));
    if (Array.isArray(saved)) unread = new Set(saved.filter(id => typeof id === 'string'));
  } catch { /* Storage may be unavailable. */ }

  let previous = new Set();
  function sync() {
    const sessions = list.getSnapshot();
    const completed = new Set();
    const next = new Set(unread);
    for (const [id, state] of status.getSnapshot()) {
      if (!state.completionUnread) continue;
      completed.add(id);
      if (!previous.has(id)) next.add(id);
    }
    previous = completed;

    const conversationVisible = panel.getSnapshot().activePanelId === null;
    for (const id of next) {
      const session = sessions.byId[id];
      if ((!session && sessions.phase === 'ready') || (conversationVisible && session?.retainedBy?.mainView > 0)) {
        next.delete(id);
      }
    }
    if (next.size === unread.size && [...next].every(id => unread.has(id))) return;
    unread = next;
    try { localStorage.setItem(unreadKey, JSON.stringify([...unread])); } catch { /* Keep the in-memory state. */ }
    for (const listener of listeners) listener();
  }

  ctx.effect(() => {
    const stops = [status.subscribe(sync), list.subscribe(sync), panel.subscribe(sync)];
    sync();
    return () => stops.forEach(stop => stop());
  });
  return {
    getSnapshot: () => unread,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function workspaceNotifications(workspaces, sessions, statuses, parents, archived, unread) {
  const owners = new Map();
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) owners.set(sessionId, workspace.workspaceId);
  }
  const bySession = new Map();
  const byFolder = new Map();
  const runningBySession = new Map();
  const runningByFolder = new Map();
  for (const id of sessions.ids) {
    const session = sessions.byId[id];
    if (!session || session.blank || session.origin === 'subagent' || archived.has(id)) continue;
    const running = (statuses.get(id)?.running ?? session.running) === true;
    const subagents = sessions.projectionsBySession?.[id]?.values?.subagentCatalog?.filter(child =>
      (statuses.get(child.id)?.running ?? sessions.byId[child.id]?.running) === true).length ?? 0;
    if (running || subagents > 0) runningBySession.set(id, { running, subagents });
    if (!running) continue;
    for (let folder = owners.get(id) ?? ungrouped; folder !== null; folder = parents.get(folder) ?? null) {
      runningByFolder.set(folder, (runningByFolder.get(folder) ?? 0) + 1);
    }
  }
  const all = [];
  for (const sessionId of sessions.ids) {
    const session = sessions.byId[sessionId];
    if (!session || session.blank || session.origin === 'subagent' || archived.has(sessionId)) continue;
    const detail = statusDetails[statuses.get(sessionId)?.pendingInteraction?.kind]
      ?? (unread.has(sessionId) && !runningBySession.has(sessionId) ? statusDetails.completed : undefined);
    if (!detail) continue;
    const notification = { ...detail, sessionId };
    bySession.set(sessionId, notification);
    all.push(notification);
    for (let folder = owners.get(sessionId) ?? ungrouped; folder !== null; folder = parents.get(folder) ?? null) {
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push(notification);
    }
  }
  for (const notifications of byFolder.values()) notifications.sort((a, b) => b.priority - a.priority);
  return { bySession, byFolder, all, runningBySession, runningByFolder };
}

function NotificationDots({ entries, translate, size }) {
  return h('span', { className: 'dwb-notifications' }, entries.map(entry => {
    const label = translate(entry.label);
    return h('span', { key: entry.sessionId, role: 'img', 'aria-label': label, title: label,
      className: 'dwb-notification', 'data-dwb-notification': entry.state }, h(StateDot, { state: entry.state, size }));
  }));
}

function readPreference() {
  try { return JSON.parse(localStorage.getItem(preferenceKey)) ?? {}; }
  catch { return {}; }
}

function savePreference(value) {
  try { localStorage.setItem(preferenceKey, JSON.stringify(value)); }
  catch { /* The view can still be used without storage. */ }
}

function usePageFade() {
  const running = useRef(new Map());
  useEffect(() => () => {
    for (const animation of running.current.values()) animation.cancel();
    running.current.clear();
  }, []);

  const [fade] = useState(() => async (element, update) => {
    if (!element?.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      update();
      return;
    }
    const animations = running.current;
    const opacity = getComputedStyle(element).opacity;
    animations.get(element)?.cancel();
    const outgoing = element.animate([{ opacity }, { opacity: 0 }], { duration: 42.5, easing: 'ease-out', fill: 'forwards' });
    animations.set(element, outgoing);
    try {
      await outgoing.finished;
      if (animations.get(element) !== outgoing || !element.isConnected) return;
      flushSync(update);
      const incoming = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 67.5, easing: 'ease-in-out' });
      outgoing.cancel();
      animations.set(element, incoming);
      await incoming.finished;
      if (animations.get(element) === incoming) animations.delete(element);
    } catch (error) {
      if (error.name !== 'AbortError') console.warn(`${id}: page transition failed`, error);
    } finally {
      if (animations.get(element) === outgoing) {
        outgoing.cancel();
        animations.delete(element);
      }
    }
  });
  return fade;
}

// Slot wrappers use `display: contents` and own no box, so climb past them
// before reading a container's geometry.
function containerOf(node) {
  let current = node ?? null;
  while (current && current !== document.body && getComputedStyle(current).display === 'contents') {
    current = current.parentElement;
  }
  return current && current !== document.body ? current : null;
}

// The host has no grouping-item slot. Walk down from the one stable anchor
// (`[data-slot="sidebar.workspaces"]`) and read the browser's own boxes by
// position: our mounts are known by class, the header is the first native child
// of the region and the list is the last one.
function useSidebarMounts(nativeText, setEnabled) {
  const [mounts, setMounts] = useState({});
  useLayoutEffect(() => {
    const grid = document.createElement('div');
    grid.className = 'dwb-mount';
    grid.hidden = true;
    const toolbar = document.createElement('div');
    toolbar.className = 'dwb-toolbar-mount';
    toolbar.hidden = true;
    const address = document.createElement('div');
    address.className = 'dwb-address-mount';
    address.hidden = true;
    const heading = document.createElement('span');
    heading.className = 'dwb-heading';
    heading.hidden = true;
    const menuMount = document.createElement('div');
    menuMount.className = 'dwb-menu-mount';
    let active;
    let workspace;
    let frame = 0;

    function sync() {
      workspace = document.querySelector('[data-slot="sidebar.workspaces"]');
      const region = containerOf(workspace?.firstElementChild);
      const area = containerOf(region?.parentElement);
      const panel = containerOf(area?.parentElement);
      const natives = region
        ? [...region.children].filter(child => ![...child.classList].some(name => name.startsWith('dwb-')))
        : [];
      const header = natives.length > 1 ? natives[0] : null;
      const list = natives.length > 1 ? natives[natives.length - 1] : null;
      const trigger = [...header?.querySelectorAll('button[aria-label]') ?? []]
        .find(button => button.getAttribute('aria-label') === nativeText('viewOptions.label'));
      const searchButton = header?.querySelector('button[aria-expanded]') ?? null;
      const searchInput = header?.querySelector('input[type="text"], input[type="search"]') ?? null;
      // The native title sits immediately before the search control.
      const title = searchButton?.parentElement?.parentElement?.previousElementSibling ?? null;
      const nativeHeading = title?.matches('span:not(.dwb-heading)') ? title : null;
      // The popup is recognised by the grouping rows it is the only menu to list
      // (the same localized strings the trigger is found by), so the body-level
      // workspace context menu -- a menu too, with other rows -- never adopts us.
      const groupLabels = ['groupBy.workspace', 'groupBy.workspaceTree', 'groupBy.flat'].map(key => {
        try {
          return nativeText(key);
        } catch {
          return null;
        }
      });
      let menu = active?.menu?.isConnected ? active.menu : null;
      if (!menu) {
        const menus = [...document.body.querySelectorAll(':scope > [role="menu"]:not([data-context-menu])')];
        menu = menus.reverse().find(node => [...node.querySelectorAll('button[role="menuitem"]')]
          .some(row => !menuMount.contains(row) && groupLabels.includes(row.textContent?.trim()))) ?? null;
      }
      // Our own separator lives inside the mount, so skip it and take the first
      // native one: every grouping row precedes it and nothing else does.
      const menuSeparator = menu
        ? [...menu.querySelectorAll('[role="separator"]')].find(node => !menuMount.contains(node)) ?? null
        : null;
      const groupRows = menu && menuSeparator
        ? [...menu.querySelectorAll('button[role="menuitem"]')].filter(row => !menuMount.contains(row)
          && Boolean(menuSeparator.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING))
        : [];
      const lastGroup = groupRows.length > 0 ? groupRows[groupRows.length - 1].parentElement : null;
      const menuBody = groupRows.length > 0 ? groupRows[0].parentElement?.parentElement ?? null : null;
      const label = menuSeparator?.nextElementSibling ?? null;
      const menuLabel = label?.getAttribute('role') === 'presentation' ? label : null;

      if (trigger && header && list) {
        if (toolbar.nextElementSibling !== header) header.before(toolbar);
        if (header.nextElementSibling !== address) header.after(address);
        if (grid.parentElement !== list) list.prepend(grid);
      } else {
        toolbar.remove();
        address.remove();
        grid.remove();
      }
      if (nativeHeading) {
        if (heading.nextElementSibling !== nativeHeading) nativeHeading.before(heading);
      } else heading.remove();
      if (lastGroup) {
        groupRows.forEach(row => row.classList.add('dwb-native-group'));
        if (lastGroup.nextElementSibling !== menuMount) lastGroup.after(menuMount);
      } else menuMount.remove();
      const searchOpen = searchButton?.getAttribute('aria-expanded') === 'true';
      const searching = Boolean(searchOpen && searchInput?.value.trim());
      const next = { grid, list, toolbar, address, header, heading, nativeHeading, trigger, menu, menuMount, menuSeparator, menuLabel, groupRows, searching, searchOpen, region, area, panel, menuBody };
      const changed = active?.menu !== menu || active?.list !== list || active?.header !== header
        || active?.nativeHeading !== nativeHeading || active?.trigger !== trigger || active?.searching !== searching
        || active?.searchOpen !== searchOpen || active?.region !== region || active?.area !== area
        || active?.panel !== panel || active?.menuBody !== menuBody;
      active = next;
      if (changed) setMounts(next);
    }

    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; sync(); });
    }

    function selectNative(event) {
      // Only our injected menu proves this is the view-options menu.
      if (!active?.menuBody?.contains(active.menuMount) || !(event.target instanceof Element)) return;
      if (active.groupRows.includes(event.target.closest('button'))) setEnabled(false, active.list);
    }

    const observer = new MutationObserver(records => {
      if (!workspace?.isConnected || records.some(record =>
        workspace.contains(record.target) || active?.menu?.contains(record.target)
        || (record.target === document.body && [...record.addedNodes, ...record.removedNodes]
          .some(node => node instanceof Element && node.matches('[role="menu"]'))))) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-label'] });
    document.addEventListener('input', schedule);
    document.addEventListener('click', selectNative, true);
    sync();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener('input', schedule);
      document.removeEventListener('click', selectNative, true);
      grid.remove();
      toolbar.remove();
      address.remove();
      heading.remove();
      menuMount.remove();
    };
  }, [nativeText, setEnabled]);
  return mounts;
}

function NavButton({ icon, label, disabled, onClick }) {
  return h(Button, {
    size: 'sm', className: 'dwb-nav-button', icon: icon && h(icon, { size: 16, 'aria-hidden': true }),
    title: label, 'aria-label': label, disabled, onClick,
  });
}

function LocateIcon({ size }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
    stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' },
    h('circle', { cx: 12, cy: 12, r: 7 }),
    h('path', { d: 'M12 2v4m0 12v4M2 12h4m12 0h4' }),
    h('circle', { cx: 12, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }));
}

function SidebarDivider({ label, toolbar, area, ratio, saveRatio }) {
  const drag = useRef(null);
  // The region area owns the navigation list right above it.
  const navigation = area?.previousElementSibling ?? null;
  const upper = navigation?.matches('nav') ? navigation : null;

  function maximum() {
    const viewport = upper.parentElement;
    return Math.max(0, viewport.getBoundingClientRect().bottom - upper.getBoundingClientRect().top - 138);
  }

  useLayoutEffect(() => {
    if (!upper || !Number.isFinite(ratio)) return;
    const resize = () => upper.style.setProperty('--dwb-navigation-height', `${Math.round(ratio * maximum())}px`);
    upper.setAttribute('data-dwb-resized-navigation', '');
    const observer = new ResizeObserver(resize);
    observer.observe(upper.parentElement);
    resize();
    return () => {
      observer.disconnect();
      upper.removeAttribute('data-dwb-resized-navigation');
      upper.style.removeProperty('--dwb-navigation-height');
    };
  }, [upper, ratio]);

  function resize(height) {
    const available = maximum();
    if (available > 0) saveRatio(Math.max(0, Math.min(1, height / available)));
  }

  return h('div', {
    className: 'dwb-divider',
    ...(upper && {
      role: 'separator', 'aria-label': label, 'aria-orientation': 'horizontal', tabIndex: 0,
      'aria-valuenow': Math.round((ratio ?? Math.min(1, upper.offsetHeight / Math.max(1, maximum()))) * 100),
      onPointerDown: event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { y: event.clientY, height: upper.offsetHeight };
      },
      onPointerMove: event => {
        if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const distance = event.clientY - drag.current.y;
        if (distance !== 0) resize(drag.current.height + distance);
      },
      onLostPointerCapture: () => { drag.current = null; },
      onDoubleClick: () => saveRatio(null),
      onKeyDown: event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        resize(upper.offsetHeight + (event.key === 'ArrowUp' ? -16 : 16));
      },
    }),
  });
}

function FolderIcon({ size }) {
  return h('img', { src: folderIcon, alt: '', width: size, height: size, draggable: false });
}

function SessionIcon({ size }) {
  return h('span', { className: 'dwb-session-icon', style: { width: size, height: size, maskImage: `url("${sessionIcon}")` } });
}

function Browser({ t, nativeText, workspaceSource, sessionSource, view, startFolder, rememberFolder, openSession, toolbar, address, heading, area, panel, display, split, saveSplit, animatePage, useContextMenu, useSessionStatus, startSession, placements, savePlacement, panelSource, scheduleSource, unreadSource }) {
  const { getTriggerProps } = useContextMenu();
  const workspaceState = useSyncExternalStore(workspaceSource.subscribe, workspaceSource.getSnapshot);
  const sessions = useSyncExternalStore(sessionSource.subscribe, sessionSource.getSnapshot);
  const statuses = useSessionStatus(snapshot => snapshot);
  const unread = useSyncExternalStore(unreadSource.subscribe, unreadSource.getSnapshot);
  const { activePanelId } = useSyncExternalStore(panelSource.subscribe, panelSource.getSnapshot);
  const sessionVisible = activePanelId === null;
  const catalog = useSyncExternalStore(scheduleSource.subscribe, scheduleSource.getSnapshot);
  const scheduledSessions = useMemo(() => {
    const ids = new Set();
    for (const task of catalog.records) {
      if (task.status !== 'active') continue;
      for (const id of task.involvedSessionIds) ids.add(id);
      const target = task.target.kind === 'new' ? task.lastDelivery?.targetSessionId : task.target.sessionId;
      if (target) ids.add(target);
    }
    return ids;
  }, [catalog.records]);
  const options = useSyncExternalStore(view.subscribe, view.getSnapshot);
  const { byId, parents, children } = useMemo(() => workspaceTree(workspaceState.items), [workspaceState.items]);
  const { byWorkspace, pinned, archived } = useMemo(() => sessionRows(workspaceState, sessions, options), [workspaceState, sessions, options]);
  const notifications = useMemo(() => workspaceNotifications(workspaceState.items, sessions, statuses, parents, archived, unread),
    [workspaceState.items, sessions, statuses, parents, archived, unread]);
  const [history, setHistory] = useState(() => startFolder === null
    ? { entries: [null], index: 0 } : { entries: [null, startFolder], index: 1 });
  const [openError, setOpenError] = useState(null);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const dragged = useRef(null);
  const locate = useRef(null);
  const crumbsRef = useRef(null);
  useEffect(() => {
    const path = crumbsRef.current;
    function scrollPath(event) {
      if (event.ctrlKey || event.metaKey || event.deltaX !== 0 || event.deltaY === 0 || path.scrollWidth <= path.clientWidth) return;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? path.clientWidth : 1;
      event.preventDefault();
      event.stopPropagation();
      path.scrollLeft += event.deltaY * scale;
    }
    path.addEventListener('wheel', scrollPath, { passive: false });
    return () => path.removeEventListener('wheel', scrollPath);
  }, [address]);
  const browserRef = useRef(null);
  useEffect(() => {
    if (selectedFolder === null) return;
    function clearSelection(event) {
      if (event.button !== 0 || (event.type === 'click' && event.detail > 0)) return;
      if (getNewSessionButton(event)) return;
      const selectedTile = browserRef.current?.querySelector('.dwb-tile[data-dwb-kind="folder"][aria-pressed="true"]');
      if (!event.composedPath().includes(selectedTile)) setSelectedFolder(null);
    }
    window.addEventListener('pointerdown', clearSelection, true);
    window.addEventListener('click', clearSelection, true);
    return () => {
      window.removeEventListener('pointerdown', clearSelection, true);
      window.removeEventListener('click', clearSelection, true);
    };
  }, [selectedFolder]);

  const exists = key => key === null || key === ungrouped || byId.has(key);
  const current = history.entries[history.index];
  const folder = exists(current) ? current : null;
  const parent = parents.get(folder) ?? null;
  const activeSession = Object.values(sessions.byId).find(session => session.retainedBy?.mainView > 0);
  const activeOwner = activeSession && workspaceState.items.find(item => item.sessionIds.includes(activeSession.id));
  let guideFolder;
  if (activeSession) {
    for (let child = activeOwner?.workspaceId ?? ungrouped; child !== null && child !== folder; child = parents.get(child) ?? null) {
      if ((parents.get(child) ?? null) !== folder) continue;
      guideFolder = child;
      break;
    }
  }
  const onlyArchived = options.archivedFilter === 'only';
  const foldersWithArchives = useMemo(() => {
    const visible = new Set();
    if (onlyArchived) for (const [key, rows] of byWorkspace) {
      if (rows.length === 0) continue;
      for (let item = key; item !== null && !visible.has(item); item = parents.get(item) ?? null) visible.add(item);
    }
    return visible;
  }, [byWorkspace, onlyArchived, parents]);
  const folders = (children.get(folder) ?? []).filter(item => !onlyArchived || foldersWithArchives.has(item.workspaceId));
  const placement = placements?.[pageKey(folder)];
  const order = placement?.order ?? [];
  const rows = byWorkspace.get(folder) ?? [];
  const rowIds = new Set(rows.map(row => row.id));
  const shortcuts = (placement?.shortcuts ?? []).map(id => sessions.byId[id]).filter(session => session
    && !rowIds.has(session.id) && (!session.blank || session.retainedBy?.mainView > 0)
    && (options.archivedFilter === 'show' || onlyArchived === archived.has(session.id)));
  const inside = new Set(notifications.byFolder.get(folder)?.map(entry => entry.sessionId));
  for (const session of shortcuts) inside.add(session.id);
  const outside = folder === null ? undefined : notifications.all.reduce((highest, entry) =>
    !inside.has(entry.sessionId) && entry.priority > (highest?.priority ?? 0) ? entry : highest, undefined);
  const workspaceLabel = workspace => workspace.title === 'default-workspace' ? nativeText('workspace.defaultName') : workspace.title;
  const crumbs = [{ key: null, label: t('home') }];
  if (folder === ungrouped) {
    crumbs.push({ key: ungrouped, label: t('ungrouped') });
  } else if (folder !== null) {
    const trail = [];
    for (let key = folder; key !== null; key = parents.get(key) ?? null) {
      const workspace = byId.get(key);
      trail.push({ key, label: workspaceLabel(workspace), path: workspace.path });
    }
    crumbs.push(...trail.reverse());
  }

  function visit(key) {
    if (key === folder) return;
    animatePage(() => {
      setOpenError(null);
      setSelectedFolder(null);
      rememberFolder(key);
      setHistory(previous => ({
        entries: [...previous.entries.slice(0, previous.index + 1), key], index: previous.index + 1,
      }));
    });
  }

  function historyTarget(direction) {
    let index = history.index + direction;
    while (index >= 0 && index < history.entries.length) {
      if (exists(history.entries[index])) return index;
      index += direction;
    }
    return undefined;
  }

  function go(index) {
    animatePage(() => {
      setOpenError(null);
      setSelectedFolder(null);
      rememberFolder(history.entries[index]);
      setHistory(previous => ({ ...previous, index }));
    });
  }

  const back = historyTarget(-1);
  const forward = historyTarget(1);
  const gestureAction = useRef(null);
  useLayoutEffect(() => {
    gestureAction.current = direction => {
      if (direction === 'up') { visit(parent); return; }
      const index = direction === 'left' ? back : forward;
      if (index !== undefined) go(index);
    };
  });
  useEffect(() => installMouseGestures(
    () => direction => gestureAction.current?.(direction),
    () => {
      const bounds = panel?.getBoundingClientRect();
      if (bounds?.width >= 112 && bounds.height >= 112) return bounds;
    },
    target => Boolean(panel?.contains(target)) && !panel.closest('[inert]') && !toolbar.hidden,
    direction => t({ left: 'back', right: 'forward', up: 'gestureUp', invalid: 'gestureInvalid' }[direction]),
  ), [toolbar, panel, t]);
  const hasUngrouped = folder === null && byWorkspace.get(ungrouped).length > 0;
  const loading = workspaceState.state !== 'error' && (workspaceState.phase !== 'ready' || sessions.phase !== 'ready');
  const entries = new Map([
    ...folders.map(item => [folderKey(item.workspaceId), item]),
    ...(hasUngrouped ? [[folderKey(ungrouped), null]] : []),
    ...[...rows, ...shortcuts].map(session => [sessionKey(session.id), session]),
  ]);
  const keys = [...new Set([...order.filter(key => entries.has(key)), ...entries.keys()])];
  const activeKey = activeSession && sessionKey(activeSession.id);
  const hasActiveTile = entries.has(activeKey);
  const empty = keys.length === 0;

  useLayoutEffect(() => {
    function createSession(event) {
      if (event.defaultPrevented || toolbar.hidden || !getNewSessionButton(event)) return;
      const selected = entries.get(selectedFolder);
      const inWorkspace = byId.has(folder);
      const workspaceId = inWorkspace ? folder : selected?.workspaceId ?? activeOwner?.workspaceId;
      if (!workspaceState.items.length) return;
      event.preventDefault();
      event.stopPropagation();
      const activeAnchor = hasActiveTile ? activeKey : folderKey(guideFolder);
      const anchor = entries.has(selectedFolder) ? selectedFolder : activeAnchor;
      setSelectedFolder(null);
      setOpenError(null);
      startSession(workspaceId, sessionId => {
        const key = sessionKey(sessionId);
        savePlacement(folder, (saved = {}) => {
          const next = [...new Set([...(saved.order ?? []), ...keys])].filter(item => item !== key);
          const index = next.indexOf(anchor);
          next.splice(index < 0 ? next.length : index + 1, 0, key);
          const shortcuts = saved.shortcuts ?? [];
          return { order: next, shortcuts: inWorkspace || shortcuts.includes(sessionId) ? shortcuts : [...shortcuts, sessionId] };
        });
      }).catch(() => setOpenError('create'));
    }

    document.addEventListener('click', createSession, true);
    return () => document.removeEventListener('click', createSession, true);
  });

  function locateCurrentSession() {
    locate.current = activeSession.id;
    if (!hasActiveTile && folder !== (activeOwner?.workspaceId ?? ungrouped) && !onlyArchived) {
      visit(activeOwner?.workspaceId ?? ungrouped);
    } else {
      revealCurrentSession();
    }
  }

  function revealCurrentSession() {
    if (locate.current === null) return;
    const item = browserRef.current.querySelector('[data-dwb-session-id="' + CSS.escape(locate.current) + '"] > button');
    if (!item) { locate.current = null; return; }
    locate.current = null;
    item.focus({ preventScroll: true });
    item.scrollIntoView({ block: 'nearest' });
  }

  function draggedPosition(event) {
    const box = event.currentTarget.getBoundingClientRect();
    if (display === 'list') return event.clientY < box.top + box.height / 2 ? 'before' : 'after';
    const before = event.clientX < box.left + box.width / 2;
    return before !== (getComputedStyle(event.currentTarget).direction === 'rtl') ? 'before' : 'after';
  }

  function dragProps(key) {
    return {
      draggable: true,
      'data-dwb-drop': dropTarget?.key === key ? dropTarget.position : undefined,
      onDragStart: event => {
        dragged.current = key;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-dsh-workspace-browser', key);
      },
      onDragOver: event => {
        if (dragged.current === null || dragged.current === key) {
          setDropTarget(null);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const position = draggedPosition(event);
        setDropTarget(previous => previous?.key === key && previous.position === position ? previous : { key, position });
      },
      onDragLeave: event => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDropTarget(previous => previous?.key === key ? null : previous);
      },
      onDrop: event => {
        const source = dragged.current;
        if (source === null || source === key || !entries.has(source)) return;
        event.preventDefault();
        const position = draggedPosition(event);
        const next = keys.filter(item => item !== source);
        next.splice(next.indexOf(key) + (position === 'after' ? 1 : 0), 0, source);
        savePlacement(folder, (saved = {}) => {
          let index = 0;
          const order = (saved.order ?? []).map(item => entries.has(item) ? next[index++] : item);
          return { ...saved, order: [...order, ...next.slice(index)] };
        });
        dragged.current = null;
        setDropTarget(null);
      },
      onDragEnd: () => {
        dragged.current = null;
        setDropTarget(null);
      },
    };
  }

  useLayoutEffect(() => {
    const crumbsElement = crumbsRef.current;
    crumbsElement.scrollLeft = crumbsElement.scrollWidth;
    const list = browserRef.current.closest('[data-dwb-grid]');
    if (list) list.scrollTop = 0;
    revealCurrentSession();
  }, [folder, display]);

  function tile({ key, label, title = label, icon, kind, activate, active, guided, pinned, archived, scheduled, menuTarget, dots, sessionId, runningText, runningCount, subagents }) {
    const subagentLabel = subagents ? nativeText(subagents === 1 ? 'status.subagentsRunning.one' : 'status.subagentsRunning.other', { n: subagents }) : undefined;
    const countBadge = display === 'icons' && runningCount > 0;
    const description = [runningText, subagentLabel, scheduled && t('scheduled'), ...(dots ?? []).map(entry => nativeText(entry.label))].filter(Boolean).join(', ');
    return h('li', { key, 'data-dwb-session-id': sessionId, ...dragProps(key) }, h(Button, {
      className: 'dwb-tile', title, 'data-dwb-kind': kind,
      'aria-label': label,
      'aria-description': description || undefined,
      'aria-current': active ? 'true' : undefined,
      'data-dwb-guide': guided ? '' : undefined,
      'aria-pressed': kind === 'folder' ? selectedFolder === key : undefined,
      ...getTriggerProps(menuTarget),
      onClick: event => {
        if (kind === 'session' || event.detail === 0) activate();
        else setSelectedFolder(key);
      },
      onDoubleClick: kind === 'folder' ? activate : undefined,
    }, h('span', { className: 'dwb-tile-icon', 'aria-hidden': true }, h(icon, { size: display === 'list' ? 16 : 30 })),
    h('span', { className: 'dwb-label' }, label),
    h('span', { className: 'dwb-tile-status' },
      runningText && h('span', {
        className: 'dwb-running', 'data-dwb-running-count': countBadge ? '' : undefined, 'aria-hidden': true,
      }, countBadge ? runningCount : runningText),
      dots?.length > 0 && h(NotificationDots, { entries: dots, translate: nativeText, size: 22 }),
      (subagentLabel || scheduled || pinned || archived) && h('span', { className: 'dwb-status-marks' },
        subagentLabel && h('span', { className: 'dwb-row-mark', role: 'img', 'aria-label': subagentLabel, title: subagentLabel },
          h(StateDot, { state: 'ongoing' })),
        scheduled && h(IconClockOutlineRegular, { className: 'dwb-row-mark', size: 14, 'aria-label': t('scheduled'), role: 'img' }),
        pinned && h(IconPinFillRegular, { className: 'dwb-row-mark', size: 13, 'aria-label': nativeText('menu.unpin'), role: 'img' }),
        archived && h(IconArchiveOutlineRegular, { className: 'dwb-row-mark', size: 13, 'aria-label': t('archived'), role: 'img' })))));
  }

  function folderTile(key, label, path) {
    const menuTarget = key === ungrouped ? undefined : { kind: 'workspace', value: { workspaceId: key, path, displayTitle: label } };
    const count = notifications.runningByFolder.get(key);
    const runningText = count ? t(count === 1 ? 'oneRunningSession' : 'runningSessions', { n: count }) : undefined;
    return tile({ key: folderKey(key), label, title: path ?? label, icon: FolderIcon, kind: 'folder',
      activate: () => visit(key), guided: sessionVisible && key === guideFolder, menuTarget, runningText, runningCount: count, dots: notifications.byFolder.get(key) });
  }

  return h('section', { className: 'dwb-browser', 'aria-label': t('panel'), ref: browserRef },
    createPortal(h(react.Fragment, null, outside && h(NotificationDots, { entries: [outside], translate: nativeText, size: 22 }),
      h('span', { className: 'dwb-heading-name' }, folder === null ? nativeText('section.workspaces') : crumbs.at(-1).label)), heading),
    createPortal(h('div', { className: 'dwb-toolbar' },
      h(SidebarDivider, { label: t('resize'), toolbar, area, ratio: split, saveRatio: saveSplit }),
      h('div', { className: 'dwb-reveal-zone' }),
      h('div', { className: 'dwb-nav-buttons dwb-reveal-control' },
        h(NavButton, { icon: outside ? undefined : IconChevronLeftOutlineRegular, label: t('back'), disabled: back === undefined, onClick: () => go(back) }),
        h(NavButton, { icon: IconChevronRightOutlineRegular, label: t('forward'), disabled: forward === undefined, onClick: () => go(forward) }),
        h(NavButton, { icon: IconChevronUpOutlineRegular, label: t('up'), disabled: folder === null, onClick: () => visit(parent) }),
        h(NavButton, { icon: LocateIcon, label: t('locate'), disabled: !activeSession || (onlyArchived && !hasActiveTile),
          onClick: locateCurrentSession }))), toolbar),
    createPortal(h('nav', { className: 'dwb-path dwb-reveal-control', 'aria-label': t('path'), ref: crumbsRef },
        h(IconFolderOpenRegular, { size: 16, className: 'dwb-indicator', 'aria-hidden': true }),
        crumbs.map(({ key, label, path }, index) => h('span', { className: 'dwb-crumb', key: key === ungrouped ? 'ungrouped' : key ?? 'home' },
          index > 0 && h(IconChevronRightOutlineRegular, { size: 12, className: 'dwb-indicator', 'aria-hidden': true }),
          index === crumbs.length - 1
            ? h('span', { className: 'dwb-current', title: path, 'aria-current': 'location' }, label)
            : h(Button, { size: 'sm', title: path, onClick: () => visit(key) }, label)))), address),
    h('div', { 'aria-busy': loading },
      workspaceState.state === 'error' && h('p', { className: 'dwb-status', role: 'status' }, t('loadError')),
      openError && h('p', { className: 'dwb-status', role: 'alert' }, openError === 'archived'
        ? nativeText('toast.archivedNotOpenable') : t(openError === 'create' ? 'createError' : 'openError')),
      empty && workspaceState.state !== 'error' && h('p', { className: 'dwb-status', role: 'status' },
        t(loading ? 'loading' : onlyArchived ? 'noArchives' : folder === null ? 'emptyHome' : 'emptyFolder')),
      !empty && h('ul', { className: 'dwb-list', 'data-dwb-display': display },
        keys.map(key => {
          const item = entries.get(key);
          if (item === null) return folderTile(ungrouped, t('ungrouped'));
          if (key.startsWith('folder:')) return folderTile(item.workspaceId, workspaceLabel(item), item.path);
          const session = item;
          const label = session.blank ? nativeText('session.new') : session.title?.trim() || nativeText('session.untitled');
          const isArchived = archived.has(session.id);
          const activity = notifications.runningBySession.get(session.id);
          const active = sessionVisible && activeKey === key;
          return tile({ key, sessionId: session.id, label, title: isArchived ? `${label} · ${t('archived')}` : label,
            icon: SessionIcon, kind: 'session',
            pinned: !isArchived && pinned.has(session.id), archived: isArchived, scheduled: !isArchived && !session.blank && scheduledSessions.has(session.id), active,
            runningText: activity?.running ? t('running') : undefined, subagents: activity?.subagents,
            dots: notifications.bySession.has(session.id) ? [notifications.bySession.get(session.id)] : undefined,
            menuTarget: session.blank ? undefined : { kind: 'session', value: { sessionId: session.id, displayTitle: label } },
            activate: () => {
              setOpenError(isArchived ? 'archived' : null);
              if (!isArchived && !active) openSession(session.id, () => setOpenError('open'));
            },
          });
        }))));
}

function SidebarExtension({ t, nativeText, workspaceSource, sessionSource, nativeEntry, openSession, startSession, useContextMenu, useSessionStatus, panelSource, scheduleSource, unreadSource }) {
  const [preference, setPreference] = useState(readPreference);
  const enabled = preference.enabled === true;
  const fade = usePageFade();
  const [actions] = useState(() => ({
    setEnabled: (enabled, list) => {
      const update = () => setPreference(previous => ({ ...previous, enabled }));
      if (list?.hasAttribute('data-dwb-grid') === enabled) return;
      fade(list, update);
    },
    rememberFolder: folder => setPreference(previous => ({ ...previous, folder })),
    setDisplay: display => setPreference(previous => ({ ...previous, display })),
    saveSplit: split => setPreference(previous => ({ ...previous, split })),
    savePlacement: (folder, update) => setPreference(previous => {
      const placements = previous.placements ?? emptyOrder;
      const key = pageKey(folder);
      return { ...previous, placements: { ...placements, [key]: update(placements[key]) } };
    }),
  }));
  const { grid, list, toolbar, address, header, heading, nativeHeading, trigger, menu, menuMount, menuSeparator, menuLabel, searching, searchOpen, region, area, panel } = useSidebarMounts(nativeText, actions.setEnabled);
  const display = preference.display === 'list' ? 'list' : 'icons';
  const entry = useSyncExternalStore(nativeEntry.subscribe, nativeEntry.getSnapshot);
  const view = useMemo(() => entry?.store?.create() ?? emptyView, [entry]);
  const animatePage = update => fade(list, update);

  function openConversation(sessionId, onError) {
    const main = document.querySelector('[data-slot="main"]');
    fade(main?.parentElement, () => {
      try { openSession(sessionId); } catch { onError(); }
    });
  }

  useEffect(() => { savePreference(preference); }, [preference]);
  useLayoutEffect(() => {
    if (!grid || !list || !header || !region) return;
    const show = enabled && Boolean(trigger);
    grid.hidden = !show || searching;
    toolbar.hidden = !show;
    address.hidden = !show;
    heading.hidden = !show;
    nativeHeading?.toggleAttribute('data-dwb-replaced-heading', show);
    region.toggleAttribute('data-dwb-layout', show);
    header.toggleAttribute('data-dwb-header', show);
    list.toggleAttribute('data-dwb-grid', show && !searching);
    return () => {
      region.removeAttribute('data-dwb-layout');
      header.removeAttribute('data-dwb-header');
      list.removeAttribute('data-dwb-grid');
      grid.hidden = true;
      toolbar.hidden = true;
      address.hidden = true;
      heading.hidden = true;
      nativeHeading?.removeAttribute('data-dwb-replaced-heading');
    };
  }, [grid, list, toolbar, address, header, heading, nativeHeading, enabled, trigger, searching, region]);
  useLayoutEffect(() => {
    region?.toggleAttribute('data-dwb-reveal-held', enabled && Boolean(searchOpen || menu));
    return () => region?.removeAttribute('data-dwb-reveal-held');
  }, [region, enabled, searchOpen, menu]);
  useLayoutEffect(() => {
    if (!enabled || !trigger || !header || !toolbar || !address || !region) return;
    const sidebar = panel ?? region;
    const divider = toolbar.querySelector('.dwb-divider');
    if (!divider) return;
    const clear = () => region.removeAttribute('data-dwb-reveal-hover');
    function update(event) {
      if (event.pointerType === 'touch') return;
      const { clientX: x, clientY: y } = event;
      const { left, right } = sidebar.getBoundingClientRect();
      const top = divider.getBoundingClientRect().bottom;
      const bottom = address.getBoundingClientRect().bottom;
      region.toggleAttribute('data-dwb-reveal-hover', x >= left && x < right && y >= top && y < bottom);
    }
    window.addEventListener('pointermove', update);
    sidebar.addEventListener('pointerleave', clear);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('pointermove', update);
      sidebar.removeEventListener('pointerleave', clear);
      window.removeEventListener('blur', clear);
      clear();
    };
  }, [enabled, trigger, header, toolbar, address, region, panel]);
  useLayoutEffect(() => {
    if (!menu) return;
    menu.toggleAttribute('data-dwb-selected', enabled);
    return () => menu.removeAttribute('data-dwb-selected');
  }, [menu, enabled]);

  function closeMenu() {
    trigger.focus({ preventScroll: true });
    trigger.click();
  }

  function menuItem(label, icon, current, select) {
    return h(MenuItemButton, { current, icon, onSelect: () => { select(); closeMenu(); } },
      h('span', { className: 'dwb-menu-label' }, t(label), current && h(IconCheckOutlineRegular, { size: 14, 'aria-hidden': true })));
  }

  return h(react.Fragment, null,
    menu && createPortal(h(react.Fragment, null,
      menuItem('panel', h(IconFolderOpenRegular, { size: 16, 'aria-hidden': true }), enabled, () => actions.setEnabled(true, list)),
      enabled && h(react.Fragment, null,
        h('div', { role: 'separator', className: menuSeparator?.className }),
        h('div', { role: 'presentation', className: menuLabel?.className }, t('display')),
        menuItem('icons', h('span', { className: 'dwb-menu-grid', 'aria-hidden': true }), display === 'icons', () => {
          if (display !== 'icons') animatePage(() => actions.setDisplay('icons'));
        }),
        menuItem('list', h(IconFlatListOutlineRegular, { size: 16, 'aria-hidden': true }), display === 'list', () => {
          if (display !== 'list') animatePage(() => actions.setDisplay('list'));
        }),
      )), menuMount),
    enabled && grid && createPortal(h(Browser, {
      t, nativeText, workspaceSource, sessionSource, view, openSession: openConversation, toolbar, address, heading, area, panel, display, animatePage, useContextMenu, useSessionStatus,
      split: !trigger ? null : preference.split, saveSplit: actions.saveSplit,
      startSession, placements: preference.placements, savePlacement: actions.savePlacement, panelSource, scheduleSource, unreadSource,
      startFolder: typeof preference.folder === 'string' ? preference.folder : null, rememberFolder: actions.rememberFolder,
    }), grid));
}

function apply(ctx) {
  const nativeText = ctx.locale.bind('workspace');
  const slots = ctx.slots;
  ctx.effect(() => ctx.locale.register(id, dictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
  });
  const workspaces = ctx.workspaces.list;
  const sessions = ctx.sessions.list;
  const navigation = ctx.uiWorkspace;
  const panel = ctx.layout.panelInfo;
  const panelSource = { subscribe: listener => panel.subscribe(listener), getSnapshot: () => panel.getSnapshot() };
  const workspaceSource = { subscribe: listener => workspaces.subscribe(listener), getSnapshot: () => workspaces.getSnapshot() };
  const sessionSource = { subscribe: listener => sessions.subscribe(listener), getSnapshot: () => sessions.getSnapshot() };
  const nativeEntry = {
    subscribe: listener => slots.subscribe('sidebar.workspaces', listener),
    getSnapshot: () => slots.entries('sidebar.workspaces').find(entry => entry.locale === 'workspace' && entry.store),
  };
  const scheduleSource = scheduleSourceFor(ctx);
  const unreadSource = completionSource(ctx);
  slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay', id, locale: id,
    inject: () => ({
      nativeText, workspaceSource, sessionSource, nativeEntry, panelSource, scheduleSource, unreadSource,
      openSession: sessionId => navigation.openSession(sessionId),
      startSession: (workspaceId, onCreated) => {
        const snapshot = sessions.getSnapshot();
        const target = workspaceId ?? workspaces.getSnapshot().items.reduce((recent, item) => {
          const latest = item.sessionIds.reduce((time, id) => Math.max(time, snapshot.byId[id]?.updatedAt ?? -Infinity), -Infinity);
          const activity = latest === -Infinity ? Date.parse(item.createdAt) : latest;
          return !recent || activity > recent.activity ? { workspaceId: item.workspaceId, activity } : recent;
        }, undefined)?.workspaceId;
        return target === undefined ? Promise.resolve() : navigation.openWorkspace(target, onCreated);
      },
    }),
  }, SidebarExtension));
}
