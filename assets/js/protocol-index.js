(function() {
  console.log("[protocol-index] script loaded");

  function sortTableByColumn(table, colIndex, numeric, direction) {
    const tbody = table.tBodies[0];
    const rows = Array.from(tbody.querySelectorAll("tr"));

    rows.sort((a, b) => {
      const av = a.children[colIndex].getAttribute("data-value") || "";
      const bv = b.children[colIndex].getAttribute("data-value") || "";

      if (numeric) {
        const an = parseFloat(av.replace(/[^0-9.]/g, "")) || 0;
        const bn = parseFloat(bv.replace(/[^0-9.]/g, "")) || 0;
        return direction * (an - bn);
      }
      return direction * av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
    });

    rows.forEach(row => tbody.appendChild(row));
  }

  // Sorting
  document.querySelectorAll(".sortable-protocol-table").forEach(table => {
    const headers = table.querySelectorAll("thead th");
    let lastSortedCol = null, lastDirection = 1;

    headers.forEach((th, colIndex) => {
      th.style.cursor = "pointer";
      th.addEventListener("click", () => {
        const isNumeric = ["sop", "pdf"].includes(th.getAttribute("data-sort"));
        
        if (lastSortedCol === colIndex) {
          lastDirection = -lastDirection;
        } else {
          lastSortedCol = colIndex;
          lastDirection = 1;
        }

        sortTableByColumn(table, colIndex, isNumeric, lastDirection);
        headers.forEach(h => h.classList.remove("sorted-asc", "sorted-desc"));
        th.classList.add(lastDirection === 1 ? "sorted-asc" : "sorted-desc");
      });
    });
  });

  // Search/filter
  const input = document.getElementById('protocol-table-query');
  const tbody = document.querySelector('#protocols tbody');
  if (!input || !tbody) return;

  const apply = () => {
    const tokens = (input.value || '').toLowerCase().trim()
      .split(/\s*(?:[+&])\s*|\s{2,}/)
      .filter(Boolean);
      
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const scored = [];

    for (const tr of rows) {
      if (!tr._fields) {
        tr._fields = {
          domain: tr.dataset.domain || '',
          level: tr.dataset.level || '',
          technique: tr.dataset.technique || '',
          topic: tr.dataset.topic || '',
          tags: tr.dataset.tags || '',
          text: tr.textContent || ''
        };
        Object.keys(tr._fields).forEach(k => tr._fields[k] = tr._fields[k].toLowerCase());
        tr._hay = Object.values(tr._fields).join(' ');
      }
      
      if (!tokens.length) {
        tr.hidden = false;
        scored.push([0, tr]);
        continue;
      }
      
      if (!tokens.every(t => tr._hay.includes(t))) {
        tr.hidden = true;
        continue;
      }

      const f = tr._fields;
      let s = 0;
      for (const t of tokens) {
        if (f.domain.includes(t)) s += 5;
        if (f.level.includes(t)) s += 5;
        if (f.technique.includes(t)) s += 4;
        if (f.topic.includes(t)) s += 3;
        if (f.tags.includes(t)) s += 2;
        if (f.text.includes(t)) s += 1;
      }
      tr.hidden = false;
      scored.push([s, tr]);
    }
    
    scored.sort((a, b) => b[0] - a[0]).forEach(([, tr]) => tbody.appendChild(tr));
  };

  let timer;
  const debounced = () => { clearTimeout(timer); timer = setTimeout(apply, 80); };

  ['input', 'change', 'search', 'paste'].forEach(evt => 
    input.addEventListener(evt, evt === 'paste' ? () => setTimeout(apply, 0) : debounced)
  );
  input.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });

  apply();
  console.log("[protocol-index] handlers attached");
})();