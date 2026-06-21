document.addEventListener("DOMContentLoaded", function () {

  /* ==== Unit conversion ==== */

  var UNIT_MAP = {
    gram: "g", kilogram: "kg", milligram: "mg", microgram: "\u00B5g", nanogram: "ng",
    liter: "L", milliliter: "mL", microliter: "\u00B5L",
    meter: "m", millimeter: "mm", micrometer: "\u00B5m", nanometer: "nm", centimeter: "cm",
    second: "s", minute: "min", hour: "h",
    celsius: "\u00B0C", fahrenheit: "\u00B0F", kelvin: "K",
    molar: "M", millimolar: "mM", micromolar: "\u00B5M", nanomolar: "nM",
    percent: "%",
    "gram per mol": "g/mol", "gram per liter": "g/L", "gram per milliliter": "g/mL",
    "milligram per liter": "mg/L", "milligram per milliliter": "mg/mL",
    "microgram per milliliter": "\u00B5g/mL", "microgram per liter": "\u00B5g/L",
    "milliliter per liter": "mL/L", "square centimeter": "cm\u00B2",
    bar: "bar", millibar: "mbar", psi: "psi",
    basepair: "bp", colonyformingunit: "cfu", dalton: "Da", kilodalton: "kDa", enzymeunit: "U",
    "enzymeunit per microliter": "U/\u00B5L", "enzymeunit per liter": "U/L",
    fold: "x", gauge: "G", gforce: "\u00D7\u2009g", kb: "kb", nucleotides: "nt",
    rpm: "rpm", ppm: "ppm", ppt: "ppt", torr: "Torr",
    unitless: "", vol: "vol", pound: "lb", inch: "in"
  };

  var PREFIXES = [["milli","m"],["micro","\u00B5"],["nano","n"],["kilo","k"]];

  function convertUnit(raw) {
    if (!raw) return "";
    if (UNIT_MAP[raw] !== undefined) return UNIT_MAP[raw];
    for (var i = 0; i < PREFIXES.length; i++) {
      var pre = PREFIXES[i][0], sym = PREFIXES[i][1];
      if (raw.indexOf(pre) === 0) {
        var base = raw.slice(pre.length);
        if (UNIT_MAP[base] !== undefined) return sym + UNIT_MAP[base];
      }
    }
    var m = raw.match(/^(.+?)\s+per\s+(.+)$/);
    if (m) {
      var n = convertUnit(m[1]), d = convertUnit(m[2]);
      if (n && d) return n + "/" + d;
    }
    return raw;
  }

  function parseUnitStr(raw) {
    if (!raw) return "";
    var rm = raw.match(/^([-\d,._]+)\s+to\s+([-\d,._]+)\s+(.+)$/);
    if (rm) return rm[1].replace(/_/g,"") + "\u2013" + rm[2].replace(/_/g,"") + " " + convertUnit(rm[3]);
    var sm = raw.match(/^([-\d,._]+)\s+(.+)$/);
    if (sm) return (sm[1].replace(/_/g,"") + " " + convertUnit(sm[2])).trim();
    return raw;
  }

  /* ==== XML helpers ==== */

  function directChildren(el, tag) {
    var out = [];
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 1 && c.tagName === tag) out.push(c);
    }
    return out;
  }

  function firstChild(el, tag) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 1 && c.tagName === tag) return c;
    }
    return null;
  }

  function textOf(el) {
    if (!el) return "";
    var t = "";
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) t += n.textContent;
      else if (n.nodeType === 1) {
        if (n.tagName === "unit") t += parseUnitStr((n.textContent||"").trim());
        else if (n.tagName === "pH") t += "pH " + n.textContent;
        else t += textOf(n);
      }
    }
    return t.trim();
  }

  function htmlOf(el) {
    if (!el) return "";
    var h = "";
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) { h += n.textContent; continue; }
      if (n.nodeType !== 1) continue;
      var tag = n.tagName;
      if (tag === "chemical") {
        var raw = n.textContent || "";
        raw = raw.replace(/_(\d+)/g, "<sub>$1</sub>");
        raw = raw.replace(/_\{([^}]+)\}/g, "<sub>$1</sub>");
        raw = raw.replace(/\^(\d+)/g, "<sup>$1</sup>");
        raw = raw.replace(/\^\{([^}]+)\}/g, "<sup>$1</sup>");
        h += raw;
      } else if (tag === "pH") h += "pH&nbsp;" + n.textContent;
      else if (tag === "sc") h += '<span style="font-variant:small-caps">' + n.textContent + "</span>";
      else if (tag === "unit") h += parseUnitStr((n.textContent||"").trim());
      else if (tag === "high") h += "<sup>" + n.textContent + "</sup>";
      else if (tag === "it") h += "<em>" + n.textContent + "</em>";
      else if (tag === "citation") {
        var refs = (n.textContent || "").split(",");
        var links = [];
        for (var ci = 0; ci < refs.length; ci++) {
          var ref = refs[ci].trim();
          var pm = ref.match(/^PMID:(\d+)$/);
          if (pm) {
            links.push('<a class="rc-cite" href="https://europepmc.org/article/med/' + pm[1] + '" target="_blank" rel="noopener noreferrer">↗︎&nbsp;' + pm[1] + '</a>');
          } else {
            links.push(ref);
          }
        }
        h += '<span class="rc-citations">[' + links.join(", ") + ']</span>';
      }
      else h += htmlOf(n);
    }
    return h;
  }

  function parseAmt(str) {
    if (!str) return { value: null, value2: null, unit: "" };
    // Numbers may carry thousands separators ("1,000") or underscore grouping;
    // strip them before parseFloat, which would otherwise stop at the comma.
    function num(s) { return parseFloat(s.replace(/[,_]/g, "")); }
    var rm = str.match(/^([-\d,._]+)\s+to\s+([-\d,._]+)\s+(.+)$/);
    if (rm) return { value: num(rm[1]), value2: num(rm[2]), unit: convertUnit(rm[3]) };
    var sm = str.match(/^([-\d,._]+)\s+(.+)$/);
    if (sm) return { value: num(sm[1]), value2: null, unit: convertUnit(sm[2]) };
    return { value: null, value2: null, unit: str };
  }

  /* ==== Parse recipe element ==== */

  function parseRecipe(el) {
    var nameEl      = firstChild(el, "name");
    var abbrEl      = firstChild(el, "abbreviation");
    var stockEl     = firstChild(el, "stock");
    var solventEl   = firstChild(el, "solvent");
    var safetyEl    = firstChild(el, "safety");

    var solvent = null;
    if (solventEl) {
      var sn = firstChild(solventEl, "name");
      var sa = firstChild(solventEl, "amount");
      var sp = firstChild(solventEl, "property");
      solvent = {
        nameHtml: sn ? htmlOf(sn) : "",
        property: sp ? textOf(sp) : "",
        amount: sa ? parseAmt(textOf(sa)) : null,
        cas: solventEl.getAttribute("CAS") || "",
        pubchem: solventEl.getAttribute("PubChem") || ""
      };
    }

    var ingredients = directChildren(el, "ingredient").map(function (ing) {
      var iName = firstChild(ing, "name");
      var iAbbr = firstChild(ing, "abbreviation");
      var iStock = firstChild(ing, "stock");
      var iAmt = firstChild(ing, "amount");
      var iFinal = firstChild(ing, "final");
      var iProps = directChildren(ing, "property").map(function (p) { return htmlOf(p); });
      return {
        refId: ing.getAttribute("id") || "",
        cas: ing.getAttribute("CAS") || "",
        pubchem: ing.getAttribute("PubChem") || "",
        type: ing.getAttribute("type") || "",
        nameHtml: iName ? htmlOf(iName) : "",
        abbrHtml: iAbbr ? htmlOf(iAbbr) : "",
        props: iProps,
        stock: iStock ? parseUnitStr(textOf(iStock)) : "",
        amount: iAmt ? parseAmt(textOf(iAmt)) : null,
        final: iFinal ? parseUnitStr(textOf(iFinal)) : "",
      };
    });

    var workup = directChildren(el, "workup").map(function (w) {
      return htmlOf(w);
    });

    var storage = directChildren(el, "storage").map(function(s) {
      return {
        cls: s.getAttribute("class") || "",
        type: s.getAttribute("type") || "",
        shelflife: s.getAttribute("shelflife") || "",
        text: textOf(s).trim()
      };
    });

    var notes = directChildren(el, "note").map(function (n) {
      return {
        type: n.getAttribute("type") || "",
        html: htmlOf(n) };
    });

    var safety = null;
    if (safetyEl) {
      var hazards = directChildren(safetyEl, "hazard").map(function (h) {
        return {
          hide: h.getAttribute("hide") === "yes",
          type: h.getAttribute("type") || "",
          category: h.getAttribute("category") || "",
          text: textOf(h)
        };
      });

      // Derive unique pictogram set from hazard types
      var seen = {};
      var pictograms = [];
      for (var hi = 0; hi < hazards.length; hi++) {
        var t = hazards[hi].type;
        if (t && !seen[t]) {
          seen[t] = true;
          pictograms.push(t);
        }
      }

      // <benign scil="…" use="…"> — an EPA Safer Choice low-concern (SILC)
      // endorsement when @scil is present; a half-circle is provisional.
      var benignEl = directChildren(safetyEl, "benign")[0];
      var benign = benignEl ? {
        scil: benignEl.getAttribute("scil") || "",
        use: benignEl.getAttribute("use") || "",
        text: textOf(benignEl)
      } : null;

      safety = {
        signal: safetyEl.getAttribute("signal") || "",
        disposal: safetyEl.getAttribute("disposal") || "",
        incomplete: safetyEl.getAttribute("incomplete") === "yes",
        gap: safetyEl.getAttribute("gap") || "",
        hazards: hazards,
        pictograms: pictograms,
        benign: benign,
        precautions: directChildren(safetyEl, "precaution").map(function (p) { return textOf(p); }),
        disposals: directChildren(safetyEl, "disposal").map(function (d) { return htmlOf(d); })
      };
    }

    var sources = directChildren(el, "source").map(function (s) {
      return {
        doc_type: s.getAttribute("doc_type") || "",
        id: s.getAttribute("id") || "",
        version: s.getAttribute("version") || "",
        primary: s.getAttribute("primary") === "yes",
        visibility: s.getAttribute("visibility") || "",
        license: s.getAttribute("license") || "",
        filename: textOf(s)
      };
    });

    return {
      id: el.getAttribute("id") || "",
      name: nameEl ? textOf(nameEl) : "",
      nameHtml: nameEl ? htmlOf(nameEl) : "",
      abbreviation: abbrEl ? textOf(abbrEl) : "",
      abbrHtml: abbrEl ? htmlOf(abbrEl) : "",
      stock: stockEl ? parseUnitStr(textOf(stockEl)) : "",
      properties: directChildren(el, "property").map(function (p) { return htmlOf(p); }),
      solvent: solvent,
      ingredients: ingredients,
      workup: workup,
      storage: storage,
      notes: notes,
      safety: safety,
      categories: directChildren(el, "category").map(function (c) { return textOf(c); }),
      sources: sources
    };
  }

  /* ==== Formatting ==== */

  function fmt(val) {
    if (val === null) return "";
    if (Math.abs(val) >= 100) return val.toFixed(0);
    if (Math.abs(val) >= 10) return val.toFixed(1);
    if (Math.abs(val) >= 1) return val.toFixed(2);
    return val.toFixed(3);
  }

  /* ==== Rendering ==== */

  function renderIngRow(ing, scale) {
    var baseVal = ing.amount && ing.amount.value !== null
      ? ing.amount.value
      : null;
    var baseVal2 = ing.amount && ing.amount.value2 !== null
      ? ing.amount.value2
      : null;

    var propsHtml = ing.props.map(function (p) {
      return ', <span class="rc-ing-props">' + p + "</span>";
    }).join("");

    var typeHtml = "";
    if (ing.type === "optional")
      typeHtml = ' <span class="rc-ing-optional">(optional)</span>';
    else if (ing.type === "fresh")
      typeHtml = ' <span class="rc-ing-optional">(add fresh)</span>';

    var refHtml = ing.refId
      ? ' <button class="rc-ref-link" data-ref="' + ing.refId + '"><span class="fa fa-vial" aria-hidden="true"></span>\u2009' + ing.refId + "</button>"
      : "";

    var casHtml = "";
    if (ing.cas) {
      var label = '[' + ing.cas + ']';
      casHtml = ing.pubchem
        ? ' <a class="rc-cas" href="https://pubchem.ncbi.nlm.nih.gov/' + ing.pubchem + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
        : ' <span class="rc-cas">' + label + '</span>';
    }

    var abbrHtml = ing.abbrHtml
      ? ' <span class="rc-ing-props">(' + ing.abbrHtml + ")</span>"
      : "";

    var refsHtml = (refHtml || casHtml)
      ? '<div class="rc-ing-refs">' + refHtml.trim() + casHtml.trim() + '</div>'
      : "";

    return "<tr>" +
      '<td class="col-amount">' +
        (baseVal !== null
          ? '<span class="rc-amt" data-base="' + baseVal + '"' +
            (baseVal2 !== null ? ' data-base2="' + baseVal2 + '"' : '') + '>' +
            (baseVal2 !== null ? fmt(baseVal) + "\u2013" + fmt(baseVal2) : fmt(baseVal)) +
            "</span>"
          : "") +
      "</td>" +
      '<td class="col-unit">' + (ing.amount ? ing.amount.unit : "") + "</td>" +
      "<td>" + ing.nameHtml + abbrHtml + propsHtml + typeHtml + refsHtml + "</td>" +
      '<td class="col-stock">' + ing.stock + "</td>" +
      '<td class="col-final">' + ing.final + "</td>" +
      "</tr>";
  }

  function renderCard(recipe, scale) {
    var h = "";
    // Header
    h += '<div class="rc-header"><div class="rc-header-top"><div>';
    h += "<h2>";
    h += '<span class="rc-name">' + recipe.nameHtml + "</span>";
    if (recipe.abbrHtml) h += ' <span class="rc-abbr">(' + recipe.abbrHtml + ")</span>";
    if (recipe.stock) h += ', <span class="rc-stock">' + recipe.stock + "</span>";
    h += "</h2>";

    if (recipe.properties.length) {
      h += '<div class="rc-props">';
      h += recipe.properties.join(", ");
      h += "</div>";
    }

    h += "</div>"; // close left block

    // Right side (stacked)
    h += '<div class="rc-header-actions">';
    h += '<button class="rc-close">\u00D7</button>';
    h += '<span class="rc-id">' + recipe.id + "</span>";
    h += "</div>";

    h += "</div></div>";

    // --- Base volume ---
    var baseVol = recipe.solvent && recipe.solvent.amount
      ? recipe.solvent.amount.value
      : null;

    var baseUnit = recipe.solvent && recipe.solvent.amount
      ? recipe.solvent.amount.unit
      : "";

    var scale = getScale(recipe.id);

    // TABLE
    h += '<table class="rc-table"><thead><tr>';
    h += '<th class="col-amount">Amount</th><th class="col-unit"></th>';
    h += "<th>Ingredient</th>";
    h += '<th class="col-stock">Stock</th><th class="col-final">Final</th>';
    h += "</tr></thead><tbody>";

    // Regular ingredient rows
    for (var i = 0; i < recipe.ingredients.length; i++) {
      h += renderIngRow(recipe.ingredients[i], scale);
    }

    // SOLVENT ROW (authoritative volume)
    if (recipe.solvent) {
      var baseVol = recipe.solvent.amount && recipe.solvent.amount.value !== null
        ? recipe.solvent.amount.value
        : null;

      var scaledVol = baseVol && scale
        ? baseVol * scale
        : null;

      h += '<tr class="solvent-row">';

      h += '<td class="col-amount">';
      if (scaledVol !== null) {
        h += 'To <input class="rc-scale-input rc-vol-input" type="text" value="' + fmt(scaledVol) + '"/>';
      } else {
        h += '';
      }
      h += '</td>';

      h += '<td class="col-unit">' +
           (recipe.solvent.amount ? recipe.solvent.amount.unit : "") +
           '</td>';

      h += '<td colspan="3">' + recipe.solvent.nameHtml;

      if (recipe.solvent.property)
        h += ', ' + recipe.solvent.property;

      if (recipe.solvent.cas) {
        var sLabel = '[' + recipe.solvent.cas + ']';
        var sCasHtml = recipe.solvent.pubchem
          ? '<a class="rc-cas" href="https://pubchem.ncbi.nlm.nih.gov/' + recipe.solvent.pubchem + '" target="_blank" rel="noopener">' + sLabel + '</a>'
          : '<span class="rc-cas">' + sLabel + '</span>';
        h += '<div class="rc-ing-refs">' + sCasHtml + '</div>';
      }

      h += '</td></tr>';
    }

    h += "</tbody></table>";

    if (baseVol && baseVol > 0) {

      var presets = [0.5, 1, 2, 5, 10];

      h += '<div class="rc-scale">';
      h += '<span class="rc-scale-label">Scale:</span>';
      h += '<div class="rc-scale-presets">';

      for (var p = 0; p < presets.length; p++) {

        var active = Math.abs(scale - presets[p]) < 0.001 ? " active" : "";

        h += '<button class="rc-scale-btn' + active + '" data-scale="' + presets[p] + '">';
        h += "× " + presets[p];
        h += "</button>";
      }

      h += "</div></div>";
    }

    // Body
    h += '<div class="rc-body">';

    // Workup — punctuation rendered as authored (matching the PDF); steps are
    // joined with a space rather than synthesising "." separators/terminators.
    if (recipe.workup.length) {
      h += '<div class="rc-workup">';
      h += recipe.workup.join(" ");
      h += "</div>";
    }

    // Storage / shelflife
    if (recipe.storage.length > 0) {
      var classMap = {
        fridge: "4\u2009°C",
        freezer: "–20\u2009°C",
        superfrost: "–80\u2009°C",
        incubator: "37\u2009°C"
      };
      var typeMap = { dark: "protected from light" };

      h += '<div class="rc-storage">';
      for (var i = 0; i < recipe.storage.length; i++) {
        var s = recipe.storage[i];
        var temp = classMap[s.cls] || "room temperature";

        if (s.shelflife) {
          h += "Stable for " + s.shelflife + " at " + temp;
        } else {
          h += (i > 0 ? "Alternatively, store" : "Store") + " at " + temp;
        }
        if (s.type && typeMap[s.type]) {
          h += ", " + typeMap[s.type];
        }
        h += ".";
        if (s.text) {
          h += " " + s.text;
        }
        if (i < recipe.storage.length - 1) h += " ";
      }
      h += "</div>";
    }

    // Notes
    var noteOrder = ["critical", "", "orientation", "quality", "explanation"];
    var noteLabels = {
      critical: "Critical",
      "": "Note",
      orientation: "Good to know",
      quality: "Quality assurance",
      explanation: "This is why"
    };
    for (var ni = 0; ni < noteOrder.length; ni++) {
      var ntype = noteOrder[ni];
      var group = recipe.notes.filter(function (n) { return n.type === ntype; });
      if (!group.length) continue;

      var cls = ntype === "critical" ? "rc-note rc-note-critical" : "rc-note";
      var label = noteLabels[ntype];

      // Punctuation is rendered as authored, matching the PDF renderer; the
      // index no longer appends "!" to critical notes or "." to the rest.
      h += '<div class="' + cls + '">';
      h += "<em>" + label + ":</em>";
      h += group.map(function (n) { return n.html; }).join(" ");
      h += "</div>";
    }

    // Safety
    if (recipe.safety) {
      var sig = recipe.safety.signal;
      // Green ("all clear") is reserved for recipes that are an EPA Safer Choice
      // low-concern (SILC) endorsement, or benign to handle AND sink-disposable.
      // A plain-benign recipe that still routes to hazardous-waste / treatment
      // gets a neutral box — green alongside "collect as hazardous waste" reads
      // as a contradiction.
      var sinkSafe = recipe.safety.disposal === "sanitary-sewer";
      var isSilc = !!(recipe.safety.benign && recipe.safety.benign.scil);
      var cls = sig === "danger" ? "rc-safety-danger"
              : sig === "warning" ? "rc-safety-warning"
              : (isSilc || sinkSafe) ? "rc-safety-none"
              : "rc-safety-disposal";

      h += '<div class="rc-safety ' + cls + '">';

      // Header: pictograms + signal badge + SILC endorsement. Emitted only when
      // it has content — a plain-benign recipe (no pictograms, no signal, no
      // SILC) would otherwise leave an empty header reserving vertical space.
      if (recipe.safety.pictograms.length || sig || isSilc) {
        h += '<div class="rc-safety-header">';

        if (recipe.safety.pictograms.length) {
          h += '<div class="rc-ghs-pictograms">';
          for (var pi = 0; pi < recipe.safety.pictograms.length; pi++) {
            var type = recipe.safety.pictograms[pi];
            var alt = type.replace(/_/g, " ");
            h += '<img class="rc-ghs-icon" src="/assets/ghs/ghs_' + type + '.svg" alt="' + alt + '" title="' + alt + '" />';
          }
          h += '</div>';
        }

        if (sig) {
          var scls = sig === "danger" ? "rc-signal-danger" : "rc-signal-warning";
          h += '<span class="rc-signal ' + scls + '">' + sig + '</span>';
        }

        if (isSilc) {
          var prov = recipe.safety.benign.scil === "green-half-circle";
          var useTitle = recipe.safety.benign.use
            ? ' title="EPA Safer Choice use class: ' + recipe.safety.benign.use + '"'
            : "";
          h += '<span class="rc-silc"' + useTitle + '>'
            + '<span class="fa fa-leaf" aria-hidden="true"></span> EPA Safer Choice'
            + (prov ? " (provisional)" : "")
            + '</span>';
        }

        h += '</div>'; // rc-safety-header
      }

      // Incomplete derivation — a component could not be classified. Mirror the
      // PDF's gap messaging so the panel never reads as a clean bill of health.
      if (recipe.safety.incomplete) {
        var gapMsg = recipe.safety.gap === "unindexed"
            ? "Contains a component outside the substance collection; classify it from its SDS before use."
          : recipe.safety.gap === "noconc"
            ? "Assess at working strength before use."
          : recipe.safety.gap === "uncharacterised"
            ? "Assess before use — a component is not yet characterised."
            : "Under review.";
        h += '<p class="rc-safety-gap">' + gapMsg + '</p>';
      }

      // Hazard statements — category 1 bold + "!", categories 2/3 normal
      var cat1  = recipe.safety.hazards.filter(function (hz) { return !hz.hide && hz.category === "1"; });
      var cat23 = recipe.safety.hazards.filter(function (hz) { return !hz.hide && hz.category !== "1"; });
      if (cat1.length || cat23.length) {
        h += '<p class="rc-safety-hazards">';
        if (cat1.length) h += '<strong>' + cat1.map(function (hz) { return hz.text; }).join('; ') + '</strong>';
        if (cat1.length && cat23.length) h += '; ';
        if (cat23.length) h += cat23.map(function (hz) { return hz.text; }).join('; ');
        h += '</p>';
      }

      // Precautionary statements
      if (recipe.safety.precautions.length) {
        h += '<ul class="rc-precaution-list">';
        for (var pc = 0; pc < recipe.safety.precautions.length; pc++) {
          h += '<li>' + recipe.safety.precautions[pc] + '</li>';
        }
        h += '</ul>';
      }

      // Disposal statements
      if (recipe.safety.disposals.length) {
        h += '<ul class="rc-disposal-list">';
        for (var dp = 0; dp < recipe.safety.disposals.length; dp++) {
          h += '<li>' + recipe.safety.disposals[dp] + '</li>';
        }
        h += '</ul>';
      }

      h += '</div>'; // rc-safety
    }

    // Sources
    if (recipe.sources.length) {
      h += '<div class="rc-sources">';
      h += '<p class="rc-source-links"><span class="rc-sources-label">Used in</span> ';
      h += recipe.sources.map(function (s) {
        var text = s.doc_type + s.id + "-v" + s.version;
        // Link only when the PDF actually exists; "public" sources without a
        // rendered file (e.g. collections) would otherwise 404.
        if (s.visibility === "public" && PDF_SET[s.filename]) {
          return '<a class="rc-source-link" target="_blank" rel="noopener noreferrer" href="/assets/protocols/pdf/' +
            s.filename + '.pdf"><span class="fa fa-external-link" aria-hidden="true"></span>\u2009' + text + '</a>';
        }
        return '<span class="rc-source-missing">' + text + '</span>';
      }).join(" &middot; ");
      h += "<p>For research use. Always verify amounts and procedures independently before use. Users are responsible for compliance with local regulations and institutional policies.</p>";
      h += "</p></div>";
    }

    h += "</div>"; // rc-body
    return h;
  }

  /* ==== State ==== */

  // Basenames of PDFs actually present under /assets/protocols/pdf/, injected by
  // the host page from Jekyll's static file list. A source is linked only when
  // its file exists here; otherwise it degrades to plain text (no broken link).
  var PDF_SET = {};
  (window.RECIPE_PDFS || []).forEach(function (n) { PDF_SET[n] = true; });

  var allRecipes = [];
  var activeCats = {};
  var selectedIds = [];
  var scaleMap = {};  // recipe id -> scale factor

  function getScale(id) { return scaleMap[id] || 1; }
  function setScale(id, s) { scaleMap[id] = s; }

  var searchEl     = document.getElementById("recipe-search");
  var listEl       = document.getElementById("recipe-list");
  var detailEl     = document.getElementById("recipe-detail");

  /* ==== Filtering ==== */

  function getFiltered() {
    const query = document.getElementById("recipe-search").value || "";
    const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);

    if (!tokens.length) return allRecipes;

    return allRecipes.filter(r => tokens.every(t => r._hay.includes(t)));
  }

  /* ==== Render list ==== */

  function renderList() {
    var filtered = getFiltered();
    var hasDetail = selectedIds.length > 0;
    var page = document.querySelector(".recipes-page");
    if (hasDetail) {
      page.classList.add("has-detail");
    } else {
      page.classList.remove("has-detail");
    }

    listEl.className = "recipe-list" + (hasDetail ? "" : " full-width");

    var h = "";

    if (filtered.length === 0) {
      h += '<button class="recipe-item disabled" disabled>';
      h += 'No recipes found';
      h += "</button>";
    } else {
      for (var i = 0; i < filtered.length; i++) {
        var r = filtered[i];
        var sel = selectedIds.indexOf(r.id) !== -1 ? " selected" : "";
        // Disambiguate same-named recipes (e.g. Tris 8.0 vs 7.4) by appending
        // stock concentration + recipe-level properties (pH …), mirroring the
        // detail-card header.
        var meta = [];
        if (r.stock) meta.push(r.stock);
        if (r.properties && r.properties.length) meta.push(r.properties.join(", "));
        var metaHtml = meta.length
          ? '<span class="recipe-item-meta">, ' + meta.join(", ") + "</span>"
          : "";
        // Native tooltip with the full label — list items often truncate (…),
        // so hovering reveals the complete name + disambiguating meta. Strip
        // markup to plain text; escape quotes so they can't break the attribute.
        var title = (r.nameHtml + metaHtml)
          .replace(/<[^>]+>/g, "")
          .replace(/"/g, "&quot;");
        h += '<button class="recipe-item' + sel + '" data-id="' + r.id + '" title="' + title + '">';
        h += '<span class="recipe-item-name">' + r.nameHtml + metaHtml + "</span>";
        h += "</button>";
      }
    }

    listEl.innerHTML = h;

    var items = listEl.querySelectorAll(".recipe-item");
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener("click", function (e) {
        if (this.disabled) {
          activeCats = {};
          searchEl.value = "";
          selectedIds = [];
          scaleMap = {};
          renderList();
          renderDetail();
          return;
        }
        var id = this.getAttribute("data-id");

        if (e.metaKey || e.ctrlKey) {
          // Multi-select: toggle this card
          var idx = selectedIds.indexOf(id);
          if (idx !== -1) {
            selectedIds.splice(idx, 1);
            delete scaleMap[id];
          } else {
            selectedIds.push(id);
          }
        } else {
          // Single-select: toggle or replace
          if (selectedIds.length === 1 && selectedIds[0] === id) {
            selectedIds = [];
            delete scaleMap[id];
          } else {
            selectedIds = [id];
            scaleMap = {};
          }
        }

        renderList();
        renderDetail();
      });
    }
  }

  /* ==== Render detail ==== */

  function renderDetail() {
    if (!selectedIds.length) { detailEl.innerHTML = ""; return; }

    var h = "";
    for (var i = 0; i < selectedIds.length; i++) {
      var recipe = allRecipes.find(function (r) { return r.id === selectedIds[i]; });
      if (recipe) {
        h += '<div class="recipe-card" data-recipe-id="' + recipe.id + '">'
          + renderCard(recipe, 1) + '</div>';
      }
    }
    detailEl.innerHTML = h;
    updateScaledValues();
    syncScaleUI();

    var lastCard = detailEl.querySelector('.recipe-card:last-child');
    if (lastCard) {
      lastCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function updateScaledValues() {
    var cards = detailEl.querySelectorAll(".recipe-card");
    cards.forEach(function (card) {
      var id = card.getAttribute("data-recipe-id");
      var s = getScale(id);
      card.querySelectorAll(".rc-amt").forEach(function (node) {
        var base = parseFloat(node.dataset.base);
        if (isNaN(base)) return;
        var base2 = parseFloat(node.dataset.base2);
        node.textContent = !isNaN(base2)
          ? fmt(base * s) + "\u2013" + fmt(base2 * s)
          : fmt(base * s);
      });
    });
  }

  function syncScaleUI() {
    var cards = detailEl.querySelectorAll(".recipe-card");
    cards.forEach(function (card) {
      var id = card.getAttribute("data-recipe-id");
      var recipe = allRecipes.find(function (r) { return r.id === id; });
      if (!recipe || !recipe.solvent || !recipe.solvent.amount) return;

      var baseVol = recipe.solvent.amount.value;
      var s = getScale(id);

      var input = card.querySelector(".rc-vol-input");
      if (input && baseVol) {
        input.value = fmt(baseVol * s);
      }

      card.querySelectorAll(".rc-scale-btn").forEach(function (btn) {
        var btnScale = parseFloat(btn.getAttribute("data-scale"));
        if (Math.abs(btnScale - s) < 1e-6) {
          btn.classList.add("active");
        } else {
          btn.classList.remove("active");
        }
      });
    });
  }

  // Delegated click events for close button, scale buttons, cross-reference links
  detailEl.addEventListener("click", function(e) {
    var card = e.target.closest(".recipe-card");
    if (!card) return;
    var id = card.getAttribute("data-recipe-id");

    // Close button
    if (e.target.closest(".rc-close")) {
      var idx = selectedIds.indexOf(id);
      if (idx !== -1) selectedIds.splice(idx, 1);
      delete scaleMap[id];
      renderList();
      renderDetail();
      return;
    }

    // Scale preset buttons
    var scaleBtn = e.target.closest(".rc-scale-btn");
    if (scaleBtn) {
      var scale = parseFloat(scaleBtn.dataset.scale);
      if (isNaN(scale) || scale <= 0) return;
      setScale(id, scale);
      syncScaleUI();
      updateScaledValues();
      return;
    }

    // Cross-reference links
    var refBtn = e.target.closest(".rc-ref-link");
    if (refBtn) {
      e.stopPropagation();
      var refId = refBtn.getAttribute("data-ref");
      var target = allRecipes.find(function (r) { return r.id === refId; });
      if (target && selectedIds.indexOf(refId) === -1) {
        selectedIds.push(refId);
      }
      renderList();
      renderDetail();
    }
  });

  detailEl.addEventListener("input", function(e) {
    if (!e.target.classList.contains("rc-vol-input")) return;
    var card = e.target.closest(".recipe-card");
    if (!card) return;
    var id = card.getAttribute("data-recipe-id");

    var v = parseFloat(e.target.value);
    if (isNaN(v) || v <= 0) return;

    var recipe = allRecipes.find(function (r) { return r.id === id; });
    if (!recipe || !recipe.solvent || !recipe.solvent.amount) return;

    var baseVol = recipe.solvent.amount.value;
    if (!baseVol || baseVol <= 0) return;

    setScale(id, v / baseVol);
    updateScaledValues();
  });

  // Re-render only when user leaves field
  detailEl.addEventListener("blur", function(e) {
    if (e.target.id === "rc-vol-input") {
      updateScaledValues();
    }
  }, true);

  /* ==== Resizable list panel ==== */

  // Width is driven by a custom property (not an inline width) so the
  // responsive width:100% rule still wins on narrow screens. Persisted across
  // visits; double-click the handle to restore the stylesheet default.
  (function () {
    var pageEl   = document.querySelector(".recipes-page");
    var layoutEl = document.querySelector(".recipe-layout");
    var panelEl  = document.querySelector(".recipe-list-panel");
    var resizer  = document.getElementById("recipe-resizer");
    if (!pageEl || !layoutEl || !panelEl || !resizer) return;

    var LS_KEY = "recipeListWidth";
    var MIN_W = 180;

    // Resolve the card's max-width (a `ch` value) and the detail panel's
    // horizontal padding to pixels. Cached; refreshed on resize since `ch`
    // tracks the font. The card cap is the floor the detail must never drop
    // below — that is what keeps the card from shrinking as the list grows.
    var cardCapPx = 0, detailPadX = 0;
    function measureMetrics() {
      var probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;visibility:hidden;height:0;width:var(--recipe-card-max,60ch)";
      detailEl.appendChild(probe);
      cardCapPx = probe.getBoundingClientRect().width || 0;
      detailEl.removeChild(probe);
      var cs = getComputedStyle(detailEl);
      detailPadX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    }
    measureMetrics();

    // Largest list width that still leaves the detail's content box >= the card
    // cap. panelWidth + detailContentWidth is invariant under the drag (the
    // resizer and gaps are fixed), so this evaluates to a stable bound.
    function maxW() {
      var panelNow = panelEl.getBoundingClientRect().width;
      var detailContent = detailEl.clientWidth - detailPadX;
      return Math.max(MIN_W, Math.round(panelNow + detailContent - cardCapPx));
    }

    function applyWidth(px) {
      var w = Math.min(Math.max(px, MIN_W), maxW());
      pageEl.style.setProperty("--recipe-list-width", w + "px");
      return w;
    }

    function store(w) { try { localStorage.setItem(LS_KEY, String(Math.round(w))); } catch (e) {} }

    // Restore a saved width (re-clamped to the current viewport).
    try {
      var saved = parseFloat(localStorage.getItem(LS_KEY));
      if (!isNaN(saved)) applyWidth(saved);
    } catch (e) {}

    var dragging = false, startX = 0, startW = 0;

    resizer.addEventListener("pointerdown", function (e) {
      dragging = true;
      startX = e.clientX;
      startW = panelEl.getBoundingClientRect().width;
      pageEl.classList.add("resizing");
      try { resizer.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });

    resizer.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      applyWidth(startW + (e.clientX - startX));
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      pageEl.classList.remove("resizing");
      try { resizer.releasePointerCapture(e.pointerId); } catch (err) {}
      store(panelEl.getBoundingClientRect().width);
    }
    resizer.addEventListener("pointerup", endDrag);
    resizer.addEventListener("pointercancel", endDrag);

    // Double-click resets to the stylesheet default.
    resizer.addEventListener("dblclick", function () {
      pageEl.style.removeProperty("--recipe-list-width");
      try { localStorage.removeItem(LS_KEY); } catch (e) {}
    });

    // Keep a stored width within bounds if the window is resized smaller.
    window.addEventListener("resize", function () {
      measureMetrics();
      if (pageEl.style.getPropertyValue("--recipe-list-width")) {
        applyWidth(panelEl.getBoundingClientRect().width);
      }
    });
  })();

  /* ==== URL parameter support ==== */

  function checkUrlParams() {
    var params = new URLSearchParams(window.location.search);
    var q = params.get("q") || params.get("id") || "";
    if (q) {
      // Try exact ID match first
      var exact = allRecipes.find(function (r) { return r.id.toLowerCase() === q.toLowerCase(); });
      if (exact) {
        selectedIds = [exact.id];
      } else {
        searchEl.value = q;
      }
    }
  }

  /* ==== Load XML ==== */

  var xmlUrl = "/assets/protocols/recipes.xml";

  fetch(xmlUrl)
    .then(function (r) {
      if (!r.ok) throw new Error("recipes.xml HTTP " + r.status);
      return r.text();
    })
    .then(function (xmlText) {
      var parser = new DOMParser();
      var doc = parser.parseFromString(xmlText, "text/xml");
      var errorNode = doc.querySelector("parsererror");
      if (errorNode) throw new Error("XML parse error");

      var els = doc.getElementsByTagName("recipe");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!el.getAttribute("id")) continue;
        if (directChildren(el, "ingredient").length === 0) continue;
        allRecipes.push(parseRecipe(el));
      }
      allRecipes.sort(function (a, b) { return a.name.localeCompare(b.name); });

      allRecipes.forEach(r => {
        if (!r._hay) {
          r._hay = [
            r.name,
            r.abbreviation,
            r.id,
            r.stock,
            (r.properties || []).join(" ").replace(/<[^>]+>/g, ""),
            (r.categories || []).join(" ")
          ].join(" ").toLowerCase();
        }
      });

      checkUrlParams();
      renderList();
      renderDetail();

      // Search input
      searchEl.addEventListener("input", function () {
        renderList();
      });
    })
    .catch(function (err) {
      console.error("Recipe load error:", err);
      detailEl.innerHTML = '<div class="recipe-card" style="padding:1rem">' +
        "<p><strong>Error:</strong> Could not load recipe data.</p></div>";
    });
});
