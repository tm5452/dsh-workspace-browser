const dragDistance = 2;
const sampleDistance = 2;
const minimumStraightness = 0.75;
const curveTolerance = 10;
const rightButton = 2;
const menuDelay = 650;
const feedbackDelay = 450;
const recognitionDelay = 34;
const trackingAttribute = 'data-dwb-mouse-gesture-tracking';
const draggingAttribute = 'data-dwb-mouse-gesture-dragging';
const labels = { left: '后退', right: '前进', up: '返回上一级', invalid: '无效手势' };

function recordPoint(gesture, { clientX: x, clientY: y, timeStamp }) {
  // Pointer and compatibility mouse events may report the same samples.
  if (timeStamp < gesture.lastSampleTime) return;
  gesture.lastSampleTime = timeStamp;
  const last = gesture.points.at(-1);
  const segment = Math.hypot(x - last.x, y - last.y);
  const start = gesture.points[0];
  gesture.tip = { x, y, remainder: segment };
  if (segment >= sampleDistance) {
    gesture.points.push(gesture.tip);
    gesture.length += segment;
    gesture.tip.remainder = 0;
  }
  gesture.maxDistance = Math.max(gesture.maxDistance, Math.hypot(x - start.x, y - start.y));
}

function isStableClick(gesture) {
  return gesture.maxDistance < dragDistance;
}

function directionOf(gesture) {
  const start = gesture.points[0];
  const x = gesture.tip.x - start.x;
  const y = gesture.tip.y - start.y;
  const distance = Math.hypot(x, y);
  const length = gesture.length + gesture.tip.remainder;
  // A straight stroke has a ratio of one. Detours and reversals increase the traveled length.
  if (distance < dragDistance || (length - distance > curveTolerance && distance < length * minimumStraightness)) {
    return 'invalid';
  }
  // The diagonals are the 45° boundaries between the four directions.
  if (Math.abs(x) >= Math.abs(y)) return x < 0 ? 'left' : 'right';
  return y < 0 ? 'up' : 'invalid';
}

function createFeedback(getBadgeBounds) {
  const overlay = document.createElement('div');
  overlay.className = 'dwb-mouse-gesture';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = [
    '<svg class="dwb-mouse-gesture-trail"><polyline /></svg>',
    '<div class="dwb-mouse-gesture-badge">',
    '<svg viewBox="0 0 24 24"><path /></svg><span></span>',
    '</div>',
  ].join('');
  const trail = overlay.querySelector('polyline');
  const icon = overlay.querySelector('.dwb-mouse-gesture-badge path');
  const label = overlay.querySelector('span');
  let timer;
  let frame;
  let displayed;

  function hide() {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    frame = undefined;
    displayed = undefined;
    trail.removeAttribute('points');
    overlay.removeAttribute('data-finished');
    overlay.removeAttribute('data-action');
    overlay.removeAttribute('data-stable-click');
    overlay.remove();
  }

  function render(gesture) {
    const points = gesture.points.map(({ x, y }) => x + ',' + y);
    points.push(gesture.tip.x + ',' + gesture.tip.y);
    trail.setAttribute('points', points.join(' '));
    overlay.toggleAttribute('data-stable-click', isStableClick(gesture));
    if (!overlay.isConnected) document.body.append(overlay);
    displayed = gesture;
  }

  function draw(gesture) {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      render(gesture);
    });
  }

  function finish(gesture) {
    cancelAnimationFrame(frame);
    frame = undefined;
    render(gesture);
    overlay.setAttribute('data-finished', '');
    timer = setTimeout(hide, feedbackDelay);
  }

  function showAction(gesture, action) {
    if (displayed !== gesture) return;
    const bounds = getBadgeBounds();
    if (!bounds) return;
    overlay.style.setProperty('--dwb-gesture-badge-x', bounds.left + bounds.width / 2 + 'px');
    overlay.style.setProperty('--dwb-gesture-badge-y', bounds.top + bounds.height / 2 + 'px');
    overlay.dataset.action = action;
    icon.setAttribute('d', action === 'invalid' ? 'M6 6l12 12M18 6 6 18' : 'M5 12h14m-6-6 6 6-6 6');
    label.textContent = labels[action];
  }

  return { draw, render, finish, showAction, hide, overlay };
}

function installMouseGestures(resolveAction, getBadgeBounds, acceptsTarget) {
  const lifetime = new AbortController();
  const options = { capture: true, signal: lifetime.signal };
  const feedback = createFeedback(getBadgeBounds);
  const root = document.documentElement;
  let gesture;
  let suppressMenuUntil = -Infinity;

  function cancel() {
    if (gesture) gesture.cancelled = true;
  }

  function block(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function start(event) {
    if (gesture && (!isStableClick(gesture) || event.button !== rightButton)) {
      block(event);
      return;
    }
    const pointer = event.type === 'pointerdown';
    if (pointer && event.pointerType !== 'mouse') return;
    if (event.button !== rightButton || !(event.buttons & rightButton)) return;
    if (!pointer && gesture && gesture.id !== undefined) return;
    gesture = undefined;
    suppressMenuUntil = -Infinity;
    feedback.hide();
    root.removeAttribute(trackingAttribute);
    const target = event.target;
    if (!(target instanceof Element) || !acceptsTarget(target)) return;
    const origin = { x: event.clientX, y: event.clientY, remainder: 0 };
    gesture = {
      id: pointer ? event.pointerId : undefined,
      points: [origin],
      tip: origin,
      length: 0,
      maxDistance: 0,
      lastSampleTime: event.timeStamp,
      perform: resolveAction(target),
    };
    feedback.draw(gesture);
    // Chromium can send the first fast move straight to an embedded preview.
    root.setAttribute(trackingAttribute, '');
    // Capture on the original hit target so a click still opens that target's menu.
    // Capturing at press also keeps the first fast move when it crosses a pane or frame.
    if (pointer) {
      try { target.setPointerCapture(event.pointerId); } catch { /* The mouse listeners can finish the stroke. */ }
    }
  }

  function move(event) {
    if (!gesture || (event.pointerType && event.pointerType !== 'mouse')) return;
    if (gesture.outside && !(event.buttons & rightButton)) {
      complete(event.timeStamp);
      return;
    }
    gesture.outside = event.clientX < 0 || event.clientX >= innerWidth
      || event.clientY < 0 || event.clientY >= innerHeight;
    for (const point of event.getCoalescedEvents?.() ?? []) recordPoint(gesture, point);
    recordPoint(gesture, event);
    if (!isStableClick(gesture)) {
      if (!root.hasAttribute(draggingAttribute)) {
        feedback.render(gesture);
        root.setAttribute(draggingAttribute, '');
        if (gesture.id !== undefined) {
          try { feedback.overlay.setPointerCapture(gesture.id); } catch { /* Window capture listeners still isolate the stroke. */ }
        }
      }
      block(event);
    }
    feedback.draw(gesture);
  }

  function release(event) {
    if (!gesture) return;
    if (event.button !== rightButton) { block(event); return; }
    if (event.pointerType && event.pointerType !== 'mouse') return;
    recordPoint(gesture, event);
    if (!isStableClick(gesture)) block(event);
    complete(event.timeStamp);
  }

  function complete(timeStamp) {
    const finished = gesture;
    gesture = undefined;
    root.removeAttribute(trackingAttribute);
    root.removeAttribute(draggingAttribute);
    if (isStableClick(finished) || finished.aborted) {
      feedback.hide();
      return;
    }
    suppressMenuUntil = timeStamp + menuDelay;
    feedback.finish(finished);
    setTimeout(() => {
      if (lifetime.signal.aborted) return;
      const action = finished.cancelled ? 'invalid' : directionOf(finished);
      feedback.showAction(finished, finished.perform ? action : 'invalid');
      if (action !== 'invalid') finished.perform?.(action);
    }, recognitionDelay);
  }

  function contextMenu(event) {
    if (event.button !== rightButton && event.pointerType !== 'mouse') return;
    if (gesture && !(event.buttons & rightButton)) {
      recordPoint(gesture, event);
      complete(event.timeStamp);
    }
    if ((!gesture || isStableClick(gesture)) && event.timeStamp > suppressMenuUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function guardInteraction(event) {
    if (gesture && !isStableClick(gesture)) block(event);
  }

  function abort() {
    if (!gesture) return;
    const { id } = gesture;
    gesture.aborted = true;
    complete(performance.now());
    if (id !== undefined && feedback.overlay.hasPointerCapture(id)) feedback.overlay.releasePointerCapture(id);
  }

  window.addEventListener('pointerdown', start, options);
  window.addEventListener('mousedown', start, options);
  window.addEventListener('pointermove', move, options);
  window.addEventListener('mousemove', move, options);
  window.addEventListener('pointerout', event => {
    if (!event.relatedTarget && (event.buttons & rightButton)) move(event);
  }, options);
  window.addEventListener('pointerup', release, options);
  window.addEventListener('mouseup', release, options);
  window.addEventListener('pointercancel', abort, options);
  for (const type of ['click', 'dblclick', 'wheel', 'dragstart', 'pointerover', 'pointerout', 'mouseover', 'mouseout']) {
    window.addEventListener(type, guardInteraction, { ...options, passive: false });
  }
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && gesture) cancel();
  }, options);
  window.addEventListener('contextmenu', contextMenu, options);
  window.addEventListener('auxclick', event => {
    guardInteraction(event);
    if (event.button === rightButton) contextMenu(event);
  }, options);
  window.addEventListener('blur', event => {
    // Capture also sees blur from inputs and rows when the right press moves focus.
    if (event.target !== window) return;
    abort();
  }, options);
  return () => {
    lifetime.abort();
    feedback.hide();
    root.removeAttribute(trackingAttribute);
    root.removeAttribute(draggingAttribute);
  };
}
