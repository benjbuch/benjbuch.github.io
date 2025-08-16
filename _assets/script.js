// Year
document.getElementById('year').textContent = new Date().getFullYear();

// Mobile menu
const btn = document.querySelector('.burger');
const menu = document.getElementById('menu');
btn.addEventListener('click', () => {
	menu.classList.toggle('open');
	btn.setAttribute('aria-expanded', menu.classList.contains('open'));
});

// Active link highlighting based on section in view
const links = Array.from(menu.querySelectorAll('a[href^="#"]'));
const map = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
const io = new IntersectionObserver((entries) => {
	entries.forEach(entry => {
		const id = entry.target.id;
		const link = map.get(id);
		if (!link) return;
		if (entry.isIntersecting) {
			links.forEach(a => a.classList.remove('active'));
			link.classList.add('active');
		}
	});
}, {
	root: document.querySelector('main'), 
	threshold: .6
});
document.querySelectorAll('section').forEach(sec => io.observe(sec));

// Close mobile menu after click
menu.querySelectorAll('a[href^="#"]').forEach(a => {
	a.addEventListener('click', (e) => {
		e.preventDefault(); // prevent body jump
		const id = a.getAttribute('href').slice(1);
		const target = document.getElementById(id);
		if (target) {
			target.scrollIntoView({
				behavior: 'smooth',
				block: 'start'
			});
		}
		menu.classList.remove('open');
		btn.setAttribute('aria-expanded', 'false');
	});
});