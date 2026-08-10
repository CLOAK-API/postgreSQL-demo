'use strict';

/**
 * Live favicon.
 *
 * Two states, taken from the CLOAK logo-animation concept:
 *   idle     — the resolved logo: three bars plus the blue dot
 *   scanning — the loader: three concentric arcs, each at its own speed
 *
 * A scan can run for several minutes, and the operator will usually switch
 * tabs while it does. The favicon is the only part of the app still visible
 * then, so it doubles as the progress indicator.
 *
 * Drawn on a canvas and swapped in as a PNG data URL. Uses setInterval rather
 * than requestAnimationFrame on purpose: rAF is throttled to a stop in a
 * background tab, which is exactly when this needs to keep moving.
 */
window.Favicon = (() => {
  const SIZE = 64;          // drawn at 64, downscaled by the browser
  const FPS = 12;           // enough to read as motion; cheap enough to ignore
  const CENTRE = SIZE / 2;

  /**
   * The bottom bar and inner arc are very light (#ddd6fe in the brand palette),
   * which disappears against a white tab strip. Light UI gets slightly deeper
   * tints so all three stay legible at 16px.
   */
  const PALETTES = {
    light: { deep: '#6d28d9', mid: '#8b5cf6', light: '#c4b5fd', dot: '#2563eb' },
    dark:  { deep: '#8b5cf6', mid: '#a78bfa', light: '#ddd6fe', dot: '#3b82f6' },
  };

  let canvas = null;
  let ctx = null;
  let link = null;
  let timer = null;
  let startedAt = 0;
  let progress = 0;         // 0..1, drawn as a subtle sweep on the outer ring
  let state = 'idle';

  let supportChecked = false;
  let isSupported = false;

  function supported() {
    // The result is cached, not the element: an element that failed to give us
    // a 2d context must not be mistaken for working support on the next call.
    if (supportChecked) return isSupported;
    supportChecked = true;
    try {
      canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      ctx = canvas.getContext?.('2d') ?? null;
      isSupported = Boolean(ctx && typeof canvas.toDataURL === 'function');
    } catch {
      isSupported = false;
    }
    if (!isSupported) { canvas = null; ctx = null; }
    return isSupported;
  }

  function palette() {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
    return dark ? PALETTES.dark : PALETTES.light;
  }

  function iconLink() {
    if (link && link.isConnected) return link;
    link = document.querySelector('link[rel~="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/png';
    return link;
  }

  function commit() {
    try {
      iconLink().href = canvas.toDataURL('image/png');
    } catch {
      /* tainted canvas or storage pressure - leave the previous icon in place */
    }
  }

  function roundedBar(x, y, w, h, fill) {
    const r = h / 2;
    ctx.fillStyle = fill;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else {
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
    }
    ctx.fill();
  }

  /** The resolved logo: three bars, longest at the top, plus the accent dot. */
  function drawLogo() {
    const c = palette();
    ctx.clearRect(0, 0, SIZE, SIZE);
    roundedBar(6, 14, 52, 11, c.deep);
    roundedBar(6, 26.5, 39, 11, c.mid);
    roundedBar(6, 39, 25, 10, c.light);
    ctx.fillStyle = c.dot;
    ctx.beginPath();
    ctx.arc(52, 32, 6.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function arc(radius, width, colour, from, sweep) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(CENTRE, CENTRE, radius, from, from + sweep);
    ctx.stroke();
  }

  /** The loader: three arcs at the speeds and directions of the brand animation. */
  function drawArcs(elapsedMs) {
    const c = palette();
    const TAU = Math.PI * 2;
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Same cadence as the reference animation: 2.2s, 1.6s reversed, 1.1s.
    arc(26, 7, c.deep, (elapsedMs / 2200) * TAU, TAU * 0.66);
    arc(17, 6.5, c.mid, -(elapsedMs / 1600) * TAU, TAU * 0.6);
    arc(9, 6, c.light, (elapsedMs / 1100) * TAU, TAU * 0.54);

    // A faint completed-arc on the outside, so a glance at the tab shows how
    // far along the scan is without needing the page.
    if (progress > 0) {
      ctx.globalAlpha = 0.9;
      arc(31, 2.5, c.dot, -Math.PI / 2, TAU * Math.min(progress, 1));
      ctx.globalAlpha = 1;
    }
  }

  function frame() {
    drawArcs(Date.now() - startedAt);
    commit();
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    /** Resolved logo — nothing running. */
    idle() {
      if (!supported()) return;
      state = 'idle';
      progress = 0;
      stopTimer();
      drawLogo();
      commit();
    },

    /** Spinning arcs for the duration of a scan. */
    scanning() {
      if (!supported()) return;
      if (state === 'scanning') return;
      state = 'scanning';
      startedAt = Date.now();

      // Someone who asked for less motion still gets a distinct scanning icon,
      // just a still one.
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
        drawArcs(0);
        commit();
        return;
      }
      stopTimer();
      frame();
      timer = setInterval(frame, Math.round(1000 / FPS));
    },

    /** 0..1 — draws the outer completion sweep. */
    setProgress(value) {
      progress = Number.isFinite(value) ? Math.max(0, Math.min(value, 1)) : 0;
    },

    get state() { return state; },
  };
})();
