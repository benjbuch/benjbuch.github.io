// Year
document.getElementById('year').textContent = new Date().getFullYear();

// Elements
const btn	= document.querySelector('.burger');
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

		// close burger regardless
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

// Close burger on Escape
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && menu.classList.contains('open')) {
		menu.classList.remove('open');
		btn?.setAttribute('aria-expanded', 'false');
	}
});

// Active link highlighting
const navLinks = Array.from(menu.querySelectorAll('a[href*="#"]'));
const hashFrom = (a) => new URL(a.href, location.href).hash.slice(1);
const linkMap	= new Map(navLinks.map(a => [hashFrom(a), a]));

const observer = new IntersectionObserver((entries) => {
	entries.forEach(entry => {
		const id = entry.target.id;
		const link = linkMap.get(id);
		if (!link) return;
		if (entry.isIntersecting) {
			navLinks.forEach(a => a.classList.remove('active'));
			link.classList.add('active');
		}
	});
}, { root: main, threshold: 0.6 });

// Observe all sections once
document.querySelectorAll('section').forEach(sec => observer.observe(sec));
