// Parse URL parameters
function getParam(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}

function setParam(name, value) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  history.replaceState(null, '', url.toString());
}

// Open external links in new tab
document.addEventListener("DOMContentLoaded", () => {
  const host = window.location.hostname;

  document.querySelectorAll('a[href^="http"]').forEach(link => {
    if (!link.hostname.includes(host)) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  });
});


// Year
document.addEventListener('DOMContentLoaded', () => {
  const y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
});

// Elements
document.addEventListener('DOMContentLoaded', () => {
  const btn  = document.querySelector('.burger');
  const menu = document.getElementById('menu');
  const main = document.querySelector('main');

  // Mobile menu toggle
  if (btn && menu) {
    btn.addEventListener('click', () => {
      menu.classList.toggle('open');
      btn.setAttribute('aria-expanded', menu.classList.contains('open'));
    });

    // Smooth scroll only on same-page; always close burger on click
    menu.querySelectorAll('.menu a[href*="#"]').forEach(a => {
      a.addEventListener('click', (e) => {
        const url = new URL(a.href, location.href);
        const samePage = (url.pathname === location.pathname);

        menu.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');

        if (samePage) {
          e.preventDefault();
          const id = url.hash.slice(1);
          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });

    // Close burger on outside click
    document.addEventListener('click', (e) => {
      if (menu.classList.contains('open') && !menu.contains(e.target) && !btn.contains(e.target)) {
        menu.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });

    // Close burger on escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menu.classList.contains('open')) {
        menu.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }
});

// Active section highlighting
(() => {
  const init = () => {
    const menu = document.getElementById('menu');
    if (!menu) return;

    const navLinks = Array.from(menu.querySelectorAll('a[href*="#"]'));
    const hashFrom = (a) => new URL(a.href, location.href).hash.slice(1);
    const linkMap  = new Map(navLinks.map(a => [hashFrom(a), a]));
    const targets  = Array.from(linkMap.keys()).map(id => document.getElementById(id)).filter(Boolean);

    const header_height = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) || 64;

    const activate = (link) => {
      if (!link) return;
      navLinks.forEach(a => a.classList.remove('active'));
      link.classList.add('active');
    };

    const updateActiveByPosition = () => {
      let best = null;
      for (const sec of targets) {
        const top = sec.getBoundingClientRect().top - header_height;
        if (top <= 1 && (!best || top > best.top)) best = { id: sec.id, top };
      }
      if (!best && targets.length) {
        const first = targets.find(sec => sec.getBoundingClientRect().top >= 0);
        if (first) best = { id: first.id, top: first.getBoundingClientRect().top - header_height };
      }
      if (best) activate(linkMap.get(best.id));
    };

    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => { updateActiveByPosition(); ticking = false; });
        ticking = true;
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    // First run after paint to avoid forced layout during initial render
    requestAnimationFrame(updateActiveByPosition);
  };

  if ('fonts' in document && document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (document.readyState === 'complete') init();
      else window.addEventListener('load', init, { once: true });
    });
  } else {
    window.addEventListener('load', init, { once: true });
  }
})();

// Highlight publications based on subject area
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tag[data-tag]')
    .forEach(btn => btn.hasAttribute('aria-pressed') || btn.setAttribute('aria-pressed', 'false'));

  const initial = getParam('tag');
  if (initial) setPublicationFilterGlobal(initial);
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.tag[data-tag]');
  if (!btn) return;

  const slug = btn.dataset.tag;
  const current = document.body.dataset.pubfilter || '';
  const next = (current === slug) ? '' : slug;

  setPublicationFilterGlobal(next);
  setParam('tag', next);
});

// Toggle select publications
(() => {
  const init = () => {
    const toggle = document.getElementById('priority-toggle');
    const lists  = Array.from(document.querySelectorAll('#publications .publist'));
    if (!toggle || lists.length === 0) return;

    const applyFilter = () => {
      const highOnly = toggle.checked;
      lists.forEach(list => {
        list.classList.toggle('high-only', highOnly);
      });
    };

    toggle.addEventListener('change', () => requestAnimationFrame(applyFilter));
    requestAnimationFrame(applyFilter);
  };

  // Prefer fonts ready (avoids font swap thrash), else fall back to load
  if ('fonts' in document && document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      // ensure stylesheets are done too
      if (document.readyState === 'complete') init();
      else window.addEventListener('load', init, { once: true });
    });
  } else {
    window.addEventListener('load', init, { once: true });
  }
})();

