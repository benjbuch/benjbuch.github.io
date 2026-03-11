(function() {
  console.log("[protocol-index] script loaded");

  function sortTableByColumn(table, colIndex, isSortCol, direction) {
    const tbody = table.tBodies[0];
    const rows = Array.from(tbody.querySelectorAll("tr"));

    rows.sort((a, b) => {
      const av = a.children[colIndex].getAttribute("data-value") || "";
      const bv = b.children[colIndex].getAttribute("data-value") || "";

      if (isSortCol) {
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
        const isSortCol = ["pdf"].includes(th.getAttribute("data-sort"));

        if (lastSortedCol === colIndex) {
          lastDirection = -lastDirection;
        } else {
          lastSortedCol = colIndex;
          lastDirection = 1;
        }

        sortTableByColumn(table, colIndex, isSortCol, lastDirection);
        headers.forEach(h => h.classList.remove("sorted-asc", "sorted-desc"));
        th.classList.add(lastDirection === 1 ? "sorted-asc" : "sorted-desc");
      });
    });
  });

  // Search/filter
  const input = document.getElementById('protocol-table-query');
  const tbody = document.querySelector('#protocols tbody');
  if (!input || !tbody) return;

  var currentView = "chapters";
  var openChapters = new Set();
  var firstRender = true;

  // Toggle handlers
  document.querySelectorAll(".view-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      currentView = this.dataset.view;
      document.querySelectorAll(".view-btn").forEach(function(b) {
        b.classList.toggle("active", b.dataset.view === currentView);
      });
      var tableWrap   = document.querySelector('.scrollable-table');
      var chapterWrap = document.getElementById('chapter-view');
      if (currentView === "table") {
        if (tableWrap)   tableWrap.removeAttribute('hidden');
        if (chapterWrap) chapterWrap.hidden = true;
      } else {
        if (tableWrap)   tableWrap.setAttribute('hidden', '');
        if (chapterWrap) chapterWrap.hidden = false;
        renderChapterView();
      }
    });
  });

  function renderChapterView() {
    var container = document.getElementById('chapter-view');
    if (!container) return;
    container.innerHTML = '';

    var allRows = Array.from(tbody.querySelectorAll('tr'));
    var rowById = {};
    allRows.forEach(function(tr) {
      var idCell = tr.children[0];
      if (idCell) rowById[idCell.getAttribute('data-value') || ''] = tr;
    });

    var chapters = Array.isArray(PROTOCOL_CHAPTERS) ? PROTOCOL_CHAPTERS : [];
    var assignedIds = new Set();
    chapters.forEach(function(ch) {
      (ch.protocols || []).forEach(function(id) { assignedIds.add(id); });
    });

    // Pre-scan to decide whether to auto-expand
    var matchCounts = chapters.map(function(ch) {
      return (ch.protocols || []).map(function(id) { return rowById[id]; })
        .filter(function(tr) { return tr && !tr.hidden; }).length;
    });
    var otherCount = allRows.filter(function(tr) {
      var idCell = tr.children[0];
      return idCell && !assignedIds.has(idCell.getAttribute('data-value') || '') && !tr.hidden;
    }).length;
    var allCounts = matchCounts.concat(otherCount > 0 ? [otherCount] : []);
    var activeCounts = allCounts.filter(function(n) { return n > 0; });
    var autoExpand = activeCounts.length > 0 &&
                     activeCounts.length < 3 &&
                     activeCounts.every(function(n) { return n < 3; });

    if (firstRender && chapters.length > 0) {
      openChapters.add(chapters[0].name);
      firstRender = false;
    }

    chapters.forEach(function(chapter) {
      var protocols = chapter.protocols || [];
      var existingRows = protocols.map(function(id) { return rowById[id]; }).filter(Boolean);
      var visibleRows  = existingRows.filter(function(tr) { return !tr.hidden; });

      var isEmpty = existingRows.length === 0;

      var group   = document.createElement('div');
      group.className = 'chapter-group' + (isEmpty ? ' chapter-group--empty' : '');

      var heading = document.createElement('div');
      heading.className = 'chapter-heading';

      var toggle = document.createElement('span');
      toggle.className = 'chapter-toggle';
      heading.appendChild(toggle);
      heading.appendChild(document.createTextNode(chapter.name));

      var badge = document.createElement('span');
      badge.className = 'chapter-count';
      badge.textContent = isEmpty ? 0 : (visibleRows.length || '');
      if (isEmpty || visibleRows.length > 0) heading.appendChild(badge);

      group.appendChild(heading);

      if (!isEmpty) {
        var content = document.createElement('div');
        content.className = 'chapter-content';

        visibleRows.forEach(function(tr) {
          var item = document.createElement('div');
          item.className = 'chapter-item';
          var titleCell = tr.children[1];
          if (titleCell) item.innerHTML = titleCell.innerHTML;
          content.appendChild(item);
        });

        if (autoExpand || openChapters.has(chapter.name)) group.classList.add('open');
        heading.addEventListener('click', function() {
          group.classList.toggle('open');
          openChapters[group.classList.contains('open') ? 'add' : 'delete'](chapter.name);
        });

        group.appendChild(content);
      }

      container.appendChild(group);
    });

    // "Other" — protocols not listed in any chapter
    var otherRows = allRows.filter(function(tr) {
      var idCell = tr.children[0];
      if (!idCell) return false;
      return !assignedIds.has(idCell.getAttribute('data-value') || '') && !tr.hidden;
    });

    if (otherRows.length > 0) {
      var otherGroup   = document.createElement('div');
      otherGroup.className = 'chapter-group';

      var otherHeading = document.createElement('div');
      otherHeading.className = 'chapter-heading';

      var otherToggle = document.createElement('span');
      otherToggle.className = 'chapter-toggle';
      otherHeading.appendChild(otherToggle);
      otherHeading.appendChild(document.createTextNode('Other'));

      var otherBadge = document.createElement('span');
      otherBadge.className = 'chapter-count';
      otherBadge.textContent = otherRows.length;
      otherHeading.appendChild(otherBadge);

      var otherContent = document.createElement('div');
      otherContent.className = 'chapter-content';

      otherRows.forEach(function(tr) {
        var item = document.createElement('div');
        item.className = 'chapter-item';
        var titleCell = tr.children[1];
        if (titleCell) item.innerHTML = titleCell.innerHTML;
        otherContent.appendChild(item);
      });

      if (autoExpand || openChapters.has('Other')) otherGroup.classList.add('open');
      otherHeading.addEventListener('click', function() {
        otherGroup.classList.toggle('open');
        openChapters[otherGroup.classList.contains('open') ? 'add' : 'delete']('Other');
      });

      otherGroup.appendChild(otherHeading);
      otherGroup.appendChild(otherContent);
      container.appendChild(otherGroup);
    }
  }

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

    if (currentView === "chapters") renderChapterView();
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
