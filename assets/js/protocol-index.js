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
      } else {
        return direction * av.localeCompare(bv, undefined, {
          numeric: true,
          sensitivity: "base"
        });
      }
    });

    rows.forEach(row => tbody.appendChild(row));
  }

  // Find ALL protocol tables on the page
  const tables = document.querySelectorAll(".sortable-protocol-table");

  if (!tables.length) {
    console.warn("[protocol-index] No sortable tables found.");
    return;
  }

  tables.forEach((table, tableIndex) => {
    console.log(`[protocol-index] attaching handlers for table ${tableIndex}`);

    const headers = table.querySelectorAll("thead th");
    let lastSortedCol = null;
    let lastDirection = 1;

    headers.forEach((th, colIndex) => {
      th.style.cursor = "pointer";

      th.addEventListener("click", () => {
        const sortKey = th.getAttribute("data-sort") || "";
        const isNumeric = (sortKey === "sop" || sortKey === "pdf");

        // Flip direction if same column clicked again (per table)
        if (lastSortedCol === colIndex) {
          lastDirection = -lastDirection;
        } else {
          lastSortedCol = colIndex;
          lastDirection = 1;
        }

        sortTableByColumn(table, colIndex, isNumeric, lastDirection);

        // Update arrow styling on headers (per table)
        headers.forEach(h => h.classList.remove("sorted-asc", "sorted-desc"));
        th.classList.add(lastDirection === 1 ? "sorted-asc" : "sorted-desc");
      });
    });
  });

  console.log("[protocol-index] click handlers attached");
})();
