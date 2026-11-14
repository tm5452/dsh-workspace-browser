const { createElement: h, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = react;
const {
  Button, MenuItemButton, IconCheckOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular, IconFolderOpenRegular, IconNewChatOutlineRegular,
  IconPinFillRegular, IconArchiveOutlineRegular, IconFlatListOutlineRegular,
} = ui;

const inject = ['slots', 'locale', 'workspaces', 'sessions', 'uiWorkspace'];
const ungrouped = '';
const defaultOptions = {};
const emptyView = { getSnapshot: () => defaultOptions, subscribe: () => () => {} };
const preferenceKey = `${id}.sidebar`;

const dictionaries = {
  zh: {
    panel: '文件夹浏览', home: '主页', path: '工作区路径', back: '后退', forward: '前进', up: '上一级',
    ungrouped: '未分组会话',
    loading: '正在加载…', loadError: '暂时无法读取工作区。', openError: '暂时无法打开此会话。',
    emptyHome: '还没有工作区。', emptyFolder: '此工作区没有子工作区或会话。', noArchives: '没有已归档会话。',
    archived: '已归档会话',
    display: '视图选项', icons: '大图标', list: '列表', resize: '调整工作区分隔位置',
  },
  en: {
    panel: 'Browse folders', home: 'Home', path: 'Workspace path', back: 'Back', forward: 'Forward', up: 'Up one level',
    ungrouped: 'Ungrouped sessions',
    loading: 'Loading…', loadError: 'Could not load workspaces.', openError: 'Could not open this session.',
    emptyHome: 'No workspaces yet.', emptyFolder: 'No child workspaces or sessions in this workspace.',
    noArchives: 'No archived sessions.', archived: 'Archived session',
    display: 'View options', icons: 'Large icons', list: 'List', resize: 'Resize workspace area',
  },
};

// Matches DSH's “By workspace tree” mode: canonical host spelling, nearest
// registered ancestor, and component boundaries on Windows and POSIX paths.
function folderPath(path) {
  const windows = /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\');
  return (windows ? path.replaceAll('\\', '/') : path).replace(/\/+$/, '');
}

function workspaceTree(items) {
  const byId = new Map(items.map(item => [item.workspaceId, item]));
  const paths = new Map(items.map(item => [item.path, item.workspaceId]));
  const folders = [...paths].map(([path, id]) => [folderPath(path), id]);
  const parents = new Map();
  const children = new Map();
  for (const item of items) {
    const child = folderPath(item.path);
    let parent = null;
    let length = -1;
    for (const [folder, folderId] of folders) {
      if (folder.length > length && child !== folder && child.startsWith(`${folder}/`)) {
        parent = folderId;
        length = folder.length;
      }
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

// The host has no grouping-item slot. Use the native view button's anchor to
// identify its menu, and leave its original rows and controls in place.
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
    let frame = 0;

    function sync() {
      const workspace = document.querySelector('[data-slot="sidebar.workspaces"]');
      const trigger = [...workspace?.querySelectorAll('button[aria-label]') ?? []]
        .find(button => button.getAttribute('aria-label') === nativeText('viewOptions.label'));
      const header = trigger?.closest('[data-sidebar-workspace-header], [class*="_sectionHeader"]');
      const nativeHeading = header?.querySelector(':scope > span[class*="_sectionLabel"]');
      const list = header?.parentElement.querySelector('[data-sidebar-list-area], [class*="_listArea"]');
      const search = header?.querySelector('button[aria-expanded="true"]');
      const searchInput = header?.querySelector('input[type="text"]');
      const anchor = trigger?.closest('[style*="anchor-name"]')?.style.getPropertyValue('anchor-name');
      const groupLabels = ['groupBy.workspace', 'groupBy.workspaceTree', 'groupBy.flat'].map(nativeText);
      const menu = trigger && [...document.querySelectorAll('[role="menu"]')].find(element =>
        (anchor && element.style.getPropertyValue('position-anchor') === anchor)
        || [...element.classList].some(name => name.endsWith('_viewOptionsMenu')));
      const groupRows = menu && [...menu.querySelectorAll('button[role="menuitem"]')]
        .filter(row => groupLabels.includes(row.textContent.trim()));
      const lastGroup = groupRows?.length === 3 ? groupRows[2].parentElement : null;
      const menuSeparator = lastGroup?.nextElementSibling?.classList.contains('dwb-menu-mount')
        ? lastGroup.nextElementSibling.nextElementSibling : lastGroup?.nextElementSibling;
      const menuLabel = menuSeparator?.nextElementSibling;

      if (trigger && list) {
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
      const searchOpen = Boolean(search);
      const searching = Boolean(searchOpen && searchInput?.value.trim());
      const next = { grid, list, toolbar, address, header, heading, nativeHeading, trigger, menu, menuMount, menuSeparator, menuLabel, groupRows, searching, searchOpen };
      const changed = active?.menu !== menu || active?.list !== list || active?.header !== header
        || active?.nativeHeading !== nativeHeading || active?.trigger !== trigger || active?.searching !== searching || active?.searchOpen !== searchOpen;
      active = next;
      if (changed) setMounts(next);
    }

    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; sync(); });
    }

    function selectNative(event) {
      if (active?.groupRows?.length === 3 && event.target instanceof Element
        && active.groupRows.includes(event.target.closest('button'))) setEnabled(false, active.list);
    }

    const observer = new MutationObserver(schedule);
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
    size: 'sm', className: 'dwb-nav-button', icon: h(icon, { size: 16, 'aria-hidden': true }),
    title: label, 'aria-label': label, disabled, onClick,
  });
}

function SidebarDivider({ label, toolbar, ratio, saveRatio }) {
  const drag = useRef(null);
  const navigation = toolbar.closest('[class*="_regionArea"]')?.previousElementSibling;
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

function Browser({ t, nativeText, workspaceSource, sessionSource, view, startFolder, rememberFolder, openSession, toolbar, address, heading, display, split, saveSplit, animatePage, useContextMenu }) {
  const { getTriggerProps } = useContextMenu();
  const workspaceState = useSyncExternalStore(workspaceSource.subscribe, workspaceSource.getSnapshot);
  const sessions = useSyncExternalStore(sessionSource.subscribe, sessionSource.getSnapshot);
  const options = useSyncExternalStore(view.subscribe, view.getSnapshot);
  const { byId, parents, children } = useMemo(() => workspaceTree(workspaceState.items), [workspaceState.items]);
  const { byWorkspace, pinned, archived } = useMemo(() => sessionRows(workspaceState, sessions, options), [workspaceState, sessions, options]);
  const [history, setHistory] = useState(() => startFolder === null
    ? { entries: [null], index: 0 } : { entries: [null, startFolder], index: 1 });
  const [openError, setOpenError] = useState(null);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const crumbsRef = useRef(null);
  const browserRef = useRef(null);

  const exists = key => key === null || key === ungrouped || byId.has(key);
  const current = history.entries[history.index];
  const folder = exists(current) ? current : null;
  const parent = parents.get(folder) ?? null;
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
  const rows = byWorkspace.get(folder) ?? [];
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
      const bounds = toolbar.closest('[class*="_sidebarCol"]')?.getBoundingClientRect();
      if (bounds?.width >= 112 && bounds.height >= 112) return bounds;
    },
    target => {
      const sidebar = toolbar.closest('[class*="_sidebarCol"]');
      return sidebar?.contains(target) && !sidebar.closest('[inert]') && !toolbar.hidden;
    },
  ), [toolbar]);
  const hasUngrouped = folder === null && byWorkspace.get(ungrouped).length > 0;
  const loading = workspaceState.state !== 'error' && (workspaceState.phase !== 'ready' || sessions.phase !== 'ready');
  const empty = folders.length === 0 && rows.length === 0 && !hasUngrouped;

  useLayoutEffect(() => {
    const crumbsElement = crumbsRef.current;
    crumbsElement.scrollLeft = crumbsElement.scrollWidth;
    const list = browserRef.current.closest('[data-dwb-grid]');
    if (list) list.scrollTop = 0;
  }, [folder, display]);

  function tile({ key, label, title = label, icon, kind, activate, active, badge, menuTarget }) {
    return h('li', { key }, h(Button, {
      className: 'dwb-tile', title, 'data-dwb-kind': kind,
      'aria-current': active ? 'true' : undefined,
      'aria-pressed': kind === 'folder' ? selectedFolder === key : undefined,
      ...getTriggerProps(menuTarget),
      onClick: event => {
        if (kind === 'session' || event.detail === 0) activate();
        else setSelectedFolder(key);
      },
      onDoubleClick: kind === 'folder' ? activate : undefined,
    }, h('span', { className: 'dwb-tile-icon', 'aria-hidden': true }, h(icon, { size: display === 'list' ? 16 : 30 }),
      badge && h(badge, { size: 13, className: 'dwb-badge' })),
    h('span', { className: 'dwb-label' }, label)));
  }

  function folderTile(key, label, path) {
    const menuTarget = key === ungrouped ? undefined : { kind: 'workspace', value: { workspaceId: key, path, displayTitle: label } };
    return tile({ key: `folder:${key}`, label, title: path ?? label, icon: FolderIcon, kind: 'folder', activate: () => visit(key), menuTarget });
  }

  return h('section', { className: 'dwb-browser', 'aria-label': t('panel'), ref: browserRef },
    createPortal(folder === null ? nativeText('section.workspaces') : crumbs.at(-1).label, heading),
    createPortal(h('div', { className: 'dwb-toolbar' },
      h(SidebarDivider, { label: t('resize'), toolbar, ratio: split, saveRatio: saveSplit }),
      h('div', { className: 'dwb-reveal-zone' }),
      h('div', { className: 'dwb-nav-buttons dwb-reveal-control' },
        h(NavButton, { icon: IconChevronLeftOutlineRegular, label: t('back'), disabled: back === undefined, onClick: () => go(back) }),
        h(NavButton, { icon: IconChevronRightOutlineRegular, label: t('forward'), disabled: forward === undefined, onClick: () => go(forward) }),
        h(NavButton, { icon: IconChevronUpOutlineRegular, label: t('up'), disabled: folder === null, onClick: () => visit(parent) }))), toolbar),
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
        ? nativeText('toast.archivedNotOpenable') : t('openError')),
      empty && workspaceState.state !== 'error' && h('p', { className: 'dwb-status', role: 'status' },
        t(loading ? 'loading' : onlyArchived ? 'noArchives' : folder === null ? 'emptyHome' : 'emptyFolder')),
      !empty && h('ul', { className: 'dwb-list', 'data-dwb-display': display },
        folders.map(item => folderTile(item.workspaceId, workspaceLabel(item), item.path)),
        hasUngrouped && folderTile(ungrouped, t('ungrouped')),
        rows.map(session => {
          const label = session.blank ? nativeText('session.new') : session.title?.trim() || nativeText('session.untitled');
          const isArchived = archived.has(session.id);
          return tile({ key: `session:${session.id}`, label, title: isArchived ? `${label} · ${t('archived')}` : label,
            icon: isArchived ? IconArchiveOutlineRegular : IconNewChatOutlineRegular, kind: 'session',
            badge: !isArchived && pinned.has(session.id) ? IconPinFillRegular : undefined,
            active: session.retainedBy?.mainView > 0,
            menuTarget: session.blank ? undefined : { kind: 'session', value: { sessionId: session.id, displayTitle: label } },
            activate: () => {
              setOpenError(isArchived ? 'archived' : null);
              if (!isArchived && !session.retainedBy?.mainView) openSession(session.id, () => setOpenError('open'));
            },
          });
        }))));
}

function SidebarExtension({ t, nativeText, workspaceSource, sessionSource, nativeEntry, openSession, useContextMenu }) {
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
  }));
  const { grid, list, toolbar, address, header, heading, nativeHeading, trigger, menu, menuMount, menuSeparator, menuLabel, searching, searchOpen } = useSidebarMounts(nativeText, actions.setEnabled);
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
    if (!grid || !list || !header) return;
    const region = header.parentElement;
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
  }, [grid, list, toolbar, address, header, heading, nativeHeading, enabled, trigger, searching]);
  useLayoutEffect(() => {
    const region = header?.parentElement;
    region?.toggleAttribute('data-dwb-reveal-held', enabled && Boolean(searchOpen || menu));
    return () => region?.removeAttribute('data-dwb-reveal-held');
  }, [header, enabled, searchOpen, menu]);
  useLayoutEffect(() => {
    if (!enabled || !trigger || !header || !toolbar || !address) return;
    const region = header.parentElement;
    const sidebar = toolbar.closest('[class*="_sidebarCol"]') ?? region;
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
  }, [enabled, trigger, header, toolbar, address]);
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
      t, nativeText, workspaceSource, sessionSource, view, openSession: openConversation, toolbar, address, heading, display, animatePage, useContextMenu,
      split: !trigger ? null : preference.split, saveSplit: actions.saveSplit,
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
  const workspaceSource = { subscribe: listener => workspaces.subscribe(listener), getSnapshot: () => workspaces.getSnapshot() };
  const sessionSource = { subscribe: listener => sessions.subscribe(listener), getSnapshot: () => sessions.getSnapshot() };
  const nativeEntry = {
    subscribe: listener => slots.subscribe('sidebar.workspaces', listener),
    getSnapshot: () => slots.entries('sidebar.workspaces').find(entry => entry.locale === 'workspace' && entry.store),
  };
  slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay', id, locale: id,
    inject: () => ({ nativeText, workspaceSource, sessionSource, nativeEntry, openSession: sessionId => navigation.openSession(sessionId) }),
  }, SidebarExtension));
}
