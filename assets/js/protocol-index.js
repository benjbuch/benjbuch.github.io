(function() {
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
      } else {
        return direction * av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
      }
    });

    rows.forEach(row => tbody.appendChild(row));
  }

  const table = document.getElementById("protocolTable");
  if (!table) return;

  const headers = table.querySelectorAll("thead th");
  let lastSortedCol = null;
  let lastDirection = 1;

  headers.forEach((th, index) => {
    th.style.cursor = "pointer";

    th.addEventListener("click", () => {
      const isNumeric = ["sop", "pdf"].includes(th.getAttribute("data-sort"));
      if (lastSortedCol === index) {
        lastDirection = -lastDirection;
      } else {
        lastSortedCol = index;
        lastDirection = 1;
      }

      sortTableByColumn(table, index, isNumeric, lastDirection);

      headers.forEach(h => h.classList.remove("sorted-asc", "sorted-desc"));
      th.classList.add(lastDirection === 1 ? "sorted-asc" : "sorted-desc");
    });
  });
})();
