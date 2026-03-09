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
        '<div class = "check-result">' +
        '<p><strong>Error:</strong> Unrecognized commit <code>' + queryHash + '</code>.</p>' +
        '<p>This PDF may be outdated or not generated from this site.</p>' +
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

      var statusHtml = "";
      if (newerChanges.length === 0) {
        statusHtml =
        '<p><strong>Status:</strong> <span class = "status-badge status-current">Current</span></p>' +
        '<p>No recorded changes after ' + snapshotDateStr + '.</p>';
      } else {
        var listItems = newerChanges.map(function (ch) {
          return '<li><strong>' + ch.time + ':</strong> ' + ch.text + '</li>';
        }).join("");

        statusHtml =
        '<p><strong>Status:</strong> <span class = "status-badge status-outdated">Outdated</span></p>' +
        '<p><a href = "' + latestLink + '" target="_blank" rel="noopener">' +
        'Open the most recent version of ' + documentId +
        '</a></p>' +
        '<p>We have ' + newerChanges.length + ' recorded update' +
        (newerChanges.length > 1 ? 's' : '') + ' after ' + snapshotDateStr + ':</p>' +
        '<ul class = "updates-list">' + listItems + '</ul>';
      }

      inputEl.textContent = "";
      resultsEl.innerHTML =
      '<section class = "check-result">' +
      '<h2>' + documentId + '</h2>' +
      '<div><strong>Commit:</strong> <code>' + record.hash + '</code></div>' +
      '<div><strong>Snapshot time:</strong> ' + snapshotDateStr + '</div>' +
      '<div class  = "result-status">' + statusHtml + '</div>' +
      '</section>';
    })
    .catch(function (err) {
      console.error("Lookup error:", err);
      inputEl.textContent = "";
      resultsEl.innerHTML = '<div class="check-result"><p><strong>Error:</strong> Could not load protocol index.</p></div>';
    });
  }
});
