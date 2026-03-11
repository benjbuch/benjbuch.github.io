document.addEventListener("DOMContentLoaded", function () {
  const formEl       = document.getElementById('checker-form');
  const inputField   = document.getElementById('hash-input');
  const inputEl      = document.getElementById('input-hash');
  const resultsEl    = document.getElementById('results');

  const params       = new URLSearchParams(window.location.search);
  const initialRaw   = (params.get("q") || "");
  const initialHash  = initialRaw.trim().slice(0, 64);

  if (inputField && initialHash) {
    inputField.value = initialHash;
  }

  if (inputField) {
    inputField.addEventListener('focus', () => setTimeout(() => inputField.select(), 0));
  }

  if (formEl) {
    formEl.addEventListener("submit", function (evt) {
      evt.preventDefault();
      const newHash = (inputField.value || "").trim();
      const url     = new URL(window.location.href);
      if (newHash) {
        url.searchParams.set("q", newHash);
      } else {
        url.searchParams.delete("q");
      }
      window.history.replaceState(null, "", url.toString());
      runLookup(newHash);
    });
  }

  runLookup(initialHash);

  function parseDateToMs(str) {
    const d = new Date(str);
    if (isNaN(d)) return null;
    return d.getTime();
  }

  function runLookup(queryHash) {
    if (!inputEl || !resultsEl) {
      console.error("Error: Required DOM nodes not found.");
      return;
    }

    if (!queryHash || queryHash.length < 7) {
      inputEl.textContent = "No commit hash provided.";
      resultsEl.innerHTML = "";
      return;
    }

    inputEl.textContent = 'Looking for commit "' + queryHash + '"…';

    var base       = "";
    var indexURL   = base + "/assets/protocols/index.json";
    var historyURL = base + "/assets/protocols/history.json";

    Promise.all([
      fetch(indexURL).then(function (r) {
        if (!r.ok) throw new Error("index.json HTTP " + r.status);
        return r.json();
      }),
      fetch(historyURL).then(function (r) {
        if (!r.ok) throw new Error("history.json HTTP " + r.status);
        return r.json();
      })
    ])
    .then(function (data) {
      var indexData   = data[0];
      var historyData = data[1];

      var qLower = queryHash.toLowerCase();

      var record = indexData.find(function (entry) {
        if (!entry.hash) return false;
        var eLower = String(entry.hash).toLowerCase();
        return eLower.startsWith(qLower);
      });

      if (!record) {
        inputEl.textContent = "";
        resultsEl.innerHTML =
        '<div class="check-result">' +
        '<div class="result-status-row">' +
        '<span class="fa fa-ban result-icon-error" aria-hidden="true"></span>' +
        '<span class="status-badge status-error">Not found</span>' +
        '</div>' +
        '<p>Commit <code>' + queryHash + '</code> was not recognised. This PDF may not have been generated from this repository.</p>' +
        '</div>';
        return;
      }

      var documentId = record.id;
      var snapshotTimeMs = parseDateToMs(record.time);

      var changelog = historyData.find(function (item) { return item.id === documentId; });
      var latestLink = "/assets/protocols/pdf/" + changelog.filename + ".pdf";

      var newerChanges = [];
      if (changelog && changelog.changes && snapshotTimeMs !== null) {
        newerChanges = changelog.changes.filter(function (change) {
          var changeMs = parseDateToMs(change.time);
          return changeMs !== null && changeMs > snapshotTimeMs;
        });
        newerChanges.sort(function (a, b) {
          return parseDateToMs(a.time) - parseDateToMs(b.time);
        });
      }

      var snapshotDateStr = "";
      if (snapshotTimeMs !== null) {
        var d = new Date(snapshotTimeMs);
        snapshotDateStr = d.toISOString().slice(0, 10);
      } else {
        snapshotDateStr = record.time;
      }

      var statusRow, updatesHtml = "";
      if (newerChanges.length === 0) {
        statusRow =
        '<span class="fa fa-check-circle result-icon-current" aria-hidden="true"></span>' +
        '<span class="status-badge status-current">Current</span>';
      } else {
        var listItems = newerChanges.map(function (ch) {
          return '<li><strong>' + ch.time + '</strong> — ' + ch.text + '</li>';
        }).join("");

        statusRow =
        '<span class="fa fa-clock result-icon-outdated" aria-hidden="true"></span>' +
        '<span class="status-badge status-outdated">Outdated</span>' +
        '<a href="' + latestLink + '" class="result-open-link" rel="noopener noreferrer">' +
        '<span class="fa fa-external-link" aria-hidden="true"></span> Open current version</a>';

        updatesHtml =
        '<p>' + newerChanges.length + ' update' + (newerChanges.length > 1 ? 's' : '') +
        ' since ' + snapshotDateStr + ':</p>' +
        '<ul class="updates-list">' + listItems + '</ul>';
      }

      inputEl.textContent = "";
      resultsEl.innerHTML =
      '<div class="check-result">' +
      '<h2>' + documentId + '</h2>' +
      '<div class="result-status-row">' + statusRow + '</div>' +
      updatesHtml +
      '</div>';
    })
    .catch(function (err) {
      console.error("Lookup error:", err);
      inputEl.textContent = "";
      resultsEl.innerHTML = '<div class="check-result"><p><strong>Error:</strong> Could not load protocol index.</p></div>';
    });
  }
});
