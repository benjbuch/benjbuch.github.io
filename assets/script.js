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

// Year
document.getElementById('year').textContent = new Date().getFullYear();

// Elements
const btn = document.querySelector('.burger');
const menu = document.getElementById('menu');
const main = document.querySelector('main');

// Mobile menu toggle
btn?.addEventListener('click', () => {
	menu.classList.toggle('open');
	btn.setAttribute('aria-expanded', menu.classList.contains('open'));
});

// Smooth scroll only on same-page; always close burger on click
document.querySelectorAll('.menu a[href*="#"]').forEach(a => {
	a.addEventListener('click', (e) => {
		const url = new URL(a.href, location.href);
		const samePage = (url.pathname === location.pathname);

		// Close burger regardless
		menu.classList.remove('open');
		btn?.setAttribute('aria-expanded', 'false');

		if (samePage) {
			e.preventDefault();
			const id = url.hash.slice(1);
			const target = document.getElementById(id);
			target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	});
});

// Close burger on outside click
document.addEventListener('click', (e) => {
	if (menu.classList.contains('open') && !menu.contains(e.target) && !btn.contains(e.target)) {
		menu.classList.remove('open');
		btn?.setAttribute('aria-expanded', 'false');
	}
});

// Close burger on escape
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && menu.classList.contains('open')) {
		menu.classList.remove('open');
		btn?.setAttribute('aria-expanded', 'false');
	}
});

// Active section highlighting
const navLinks = Array.from(menu.querySelectorAll('a[href*="#"]'));
const hashFrom = (a) => new URL(a.href, location.href).hash.slice(1);
const linkMap	= new Map(navLinks.map(a => [hashFrom(a), a]));

const targets = Array.from(linkMap.keys())
	.map(id => document.getElementById(id))
	.filter(Boolean);

const header_height = parseFloat(
	getComputedStyle(document.documentElement)
		.getPropertyValue('--header-height')
) || 64;

function activate(link) {
	if (!link) return;
	navLinks.forEach(a => a.classList.remove('active'));
	link.classList.add('active');
}

function updateActiveByPosition() {
	let best = null; // { id, top }
	for (const sec of targets) {
		const top = sec.getBoundingClientRect().top - header_height;
		// Choose the section whose top is <= header and closest to it
		if (top <= 1) {
			if (!best || top > best.top) best = { id: sec.id, top };
		}
	}
	// If none are above header yet, pick the first section in view
	if (!best && targets.length) {
		const first = targets.find(sec => sec.getBoundingClientRect().top >= 0);
		if (first) best = { id: first.id, top: first.getBoundingClientRect().top - header_height };
	}
	if (best) activate(linkMap.get(best.id));
}

// Avoid flooding on scroll by requestAnimationFrame throttling
let ticking = false;

function onScroll() {
	if (!ticking) {
		requestAnimationFrame(() => {
			updateActiveByPosition();
			ticking = false;
		});
		ticking = true;
	}
}

window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onScroll, { passive: true });

document.addEventListener('DOMContentLoaded', updateActiveByPosition);

// Highlight publications based on subject area
function setPublicationFilterGlobal(slug) {
	const root = document.body;
	if (slug) root.dataset.pubfilter = slug;
	else delete root.dataset.pubfilter;

	document.querySelectorAll('.tag[data-tag]').forEach(btn => {
		btn.setAttribute('aria-pressed', String(btn.dataset.tag === slug));
	});
}

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
document.addEventListener('DOMContentLoaded', () => {
	const toggle = document.getElementById('priority-toggle');
	const items = document.querySelectorAll('#publications .publist .pub[data-priority]');
	if (!toggle || items.length === 0) return;

	function applyFilter() {
		const showHighOnly = toggle.checked;
		items.forEach(li => {
			const isHigh = (li.dataset.priority || 'medium').toLowerCase() === 'high';
			li.classList.toggle('is-hidden', showHighOnly && !isHigh);
		});
	}

	toggle.addEventListener('change', applyFilter);
	applyFilter();
});
