// GENERATED — do not edit. Edit copy/messages.yaml instead.
//
// Loaded two ways, which is why it is written as a global assignment guarded for both:
// index.html serves it as a plain <script> (so `MESSAGES` lands on window), and the node
// suites require() it (so it must also come back through module.exports).

const MESSAGES = {
  "placeholders": {
    "family": "the histone family token — H3, H2A",
    "variant": "the variant token the reader wrote a number after. An engine frame key may name an equivalence (caH2A|H2A.1); it is spelled \"caH2A or H2A.1\" before it reaches here",
    "variants": "the covering variants, as a list — \"H2A.X\" · \"H2A.X and H2A.Z\" · \"A, B and C\"",
    "position": "the stated residue number. Terminal marks render as α or ω",
    "residue": "the residue at the position, after any substitution",
    "allowed": "the residues that CAN carry the modification, comma-joined",
    "modification": "the modification token alone — ac, me3. Never the whole mark",
    "mark": "the mark as written, position and all — K139M, 130ac",
    "site": "the named terminus — \"N-terminal amine\", \"C-terminal carboxyl\"",
    "what": "the handle that could not be resolved, or failing that the query as typed"
  },
  "syntax_error": {
    "headline_fallback": "Unrecognized notation",
    "lead": "One of these would fit here:",
    "groups": {
      "family": "a histone family",
      "variant": "a histone variant",
      "entity": "a gene name or accession",
      "name": "more of the histone family, variant or accession name, or an (optional) <b>:<\/b> to flush the descriptor",
      "colon": "<b>:<\/b> to flush the descriptor",
      "residue": "an amino acid",
      "number": "a residue number, position, or count",
      "mod": "a modification",
      "terminus": "<b>α<\/b> or <b>ω<\/b> – a terminal modification",
      "paren": "<b>(<\/b> – a nucleosome group",
      "open": "<b>[<\/b> or <b>{<\/b> – a protein segment or an associative group",
      "close": "<b>)<\/b> <b>]<\/b> or <b>}<\/b> – a closing mark",
      "range": "<b>-<\/b> – a range delimiter, as in <b>1-40<\/b>",
      "polarity": "<b>+<\/b> or <b>-<\/b> – a linker's polarity",
      "not": "<b>!<\/b> – not this",
      "comma": "<b>,<\/b> or <b>/<\/b> – and this",
      "or": "<b>|<\/b> – or this",
      "at": "<b>·<\/b> or <b>•<\/b> or <b>@<\/b> – along with that"
    },
    "nothing_fits": "This notation is already complete. Close up the whitespace, replace it with {at}, or remove what follows.",
    "x_in_wild_type": "<b>X<\/b> stands for the substituted residue, not the original. Write <code>H3:27M<\/code> for any residue at 27, or <code>H3:K27X<\/code> for K27 substituted by anything.\n",
    "example_preferences": {
      "mod": ["ac", "me3", "ph", "ub"],
      "family": null,
      "variant": ["H3.1", "H3.3", "H2A.Z", "macroH2A.1"],
      "entity": ["HIST1H3A", "HIST1H4A", "H3C1", "H2AFZ"]
    },
    "group_order": ["family", "variant", "entity", "name", "colon", "residue", "number", "mod", "terminus", "paren", "open", "close", "range", "polarity", "not", "comma", "or", "at"]
  },
  "conditions": {
    "ATP+": "ATP present",
    "ATP-": "ATP absent",
    "ATP−": "ATP absent",
    "enzyme": "enzyme added",
    "vehicle": "vehicle only — no enzyme",
    "MgCl2": "magnesium chloride added"
  },
  "physics_error": {
    "ptm-residue-incompatible": {
      "head": "Incompatible modification",
      "body": "{residue}{position} cannot carry {modification}. Only {allowed} can carry {modification}.\n",
      "hint": "Specify the substitution or the modification, but not both.\n"
    },
    "ptm-site-incompatible": {
      "head": "Incompatible modification",
      "body": "The {site} cannot carry {modification}. α and ω are the polypeptide termini, not a side chain.\n",
      "hint": "Specify side-chain modifications by residue number.\n"
    },
    "site-not-substitutable": {
      "head": "Incompatible site",
      "body": "α and ω are the polypeptide termini, not a side chain. There is nothing at {position} to substitute.\n",
      "hint": "Specify side-chain substitutions by residue number.\n"
    },
    "mark-conflict": {
      "head": "Conflicting notation",
      "body": "Position {position} is given two different states in this notation.\n",
      "hint": "Specify alternative substitutions <code>H3:K27M|L<\/code> or modifications <code>H3:K27ac|me3<\/code> using <b>|<\/b> instead.\n"
    },
    "sub-complex": {
      "head": "Not a nucleosomal sub-complex",
      "body": "The bracketed entities do not associate with each other.\n",
      "hint": "Drop the inner brackets as in <code>(H2A@H2A)<\/code>.\n"
    },
    "fallback": {
      "head": "Not a stable assembly",
      "body": "Nothing holds this combination together.\n",
      "hint": "Free assemblies take the form of a <code>[H3@H4]2<\/code> tetramer, or a <code>[H2A@H2B]<\/code> dimer.\n"
    }
  },
  "resolve_error": {
    "unresolved-handle": {
      "head": "Unknown handle",
      "body": "{what} is not a UniProt accession, protein name, or gene symbol.\n",
      "hint": "Specify a family (<code>H3<\/code>), a variant (<code>H2A.Z<\/code>), or an Uniprot accession (<code>P68431<\/code>).\n"
    },
    "variant-cannot-carry": {
      "head": "Incompatible modification",
      "body": "No {family} residue {position} can carry {modification}. {variants} reach position {position}, but none of their residues can carry it.\n",
      "hint": "Check the alignment grid for {family} for residues at position {position}.\n"
    },
    "position-variant-only-variant": {
      "head": "Position not in this variant",
      "body": "{variant} numbering stops short of {position}. In {family}, {variants} reach it.\n",
      "hint": "Widen to the family (<code>{family}:{mark}<\/code>), or specify a variant that reaches position {position}.\n"
    },
    "position-variant-only-species": {
      "head": "Position only in some variants",
      "body": "{family} numbering stops short of {position}. {variants} reach it.\n",
      "hint": "Specify one of those variants, or check the number against the alignment grid.\n"
    },
    "position-out-of-range": {
      "head": "Position not in this family",
      "body": "No {family} has residue {position}, in any variant.\n",
      "hint": "Check the alignment grid for how far each {family} runs.\n"
    },
    "fallback": {
      "head": "Unresolved query",
      "body": "This query names something that cannot be resolved."
    }
  },
  "tokens": {
    "ptm": ["me", "me1", "me2", "me3", "me2a", "me2s", "ac", "bhb", "bu", "cr", "hib", "hxo", "la", "mal", "pro", "su", "vl", "ph", "ub", "ub1", "ubn", "sumo", "nedd", "dop", "his", "ser", "GlcNAc", "ar", "ar1", "arn", "gly", "cml", "cel", "cit", "mp"],
    "family": ["H2A", "H2B", "H3", "H4", "H1"],
    "variant": ["caH2A", "ca_H2A", "ca H2A", "canonical_H2A", "canonical H2A", "H2A.1", "H2A1", "TH2A", "TS H2A.1", "H2A.B", "H2AB", "H2A.Bbd", "H2A.Lap1", "H2A.L", "H2AL", "H2A.Lap2", "H2A.Lap3", "H2A.P", "H2AP", "H2A.Lap4", "HIP17", "HYPM", "CXorf27", "H2A.W", "H2AW", "H2A.X", "H2AX", "H2A.Z", "H2AZ", "H2AV", "H2A.Zc", "H2A.V", "H2Av", "H2AvD", "D2", "Htz1p", "hv1", "member Z", "H2A.Z.1", "H2A.Z-1", "H2AZ.1", "H2A.Z.2", "H2A.Z-2", "H2AZ.2", "macroH2A", "mH2A", "macroH2A.1", "macroH2A1", "macroH2A1.1", "macroH2A1.2", "mH2A1", "MACROH2A1", "macroH2A.2", "macroH2A2", "macroH2A2.1", "mH2A2", "MACROH2A2", "caH2B", "ca_H2B", "ca H2B", "canonical_H2B", "canonical H2B", "H2B.1", "H2B1", "TH2B", "hTSH2B", "sperm_H2B", "sperm H2B", "early H2B", "cleavage H2B", "subH2B", "H2BL1", "subH2Bv", "H2B.W", "H2BW", "H2BFWT", "H2B.Z", "H2BZ", "H2Bv", "caH3", "ca_H3", "ca H3", "canonical_H3", "canonical H3", "H3.1", "H31", "H3.2", "H32", "H3.3", "H33", "hv2", "soH3-1", "soH3-2", "H3.4", "H34", "H3T", "H3.1t", "H3.5", "H35", "H3.Y", "H3Y", "H3.X", "H3X", "cenH3", "CENP-A", "CENPA", "CNA1", "CNP1", "Cse4", "HCP-3", "HTR12", "cid", "caH4", "ca_H4", "ca H4", "canonical_H4", "canonical H4", "H4G", "H4.G", "caH1", "ca_H1", "ca H1", "canonical_H1", "canonical H1", "gen_H1", "gen H1", "generic_H1", "generic H1", "scH1", "H1.0", "H10", "H5", "H1.10", "H1x", "H1.X", "H1X", "H1.9", "H19", "Hils1", "H1.8", "H18", "OO_H1.8", "OO H1.8", "H1oo", "H1.7", "H17", "TS_H1.7", "TS H1.7", "H1T2", "H1.6", "H16", "TS_H1.6", "TS H1.6", "H1t", "H1.1", "H11", "HIST1H1A", "H1-1", "H1a", "H1.2", "H12", "HIST1H1C", "H1-2", "H1c", "H1.3", "H13", "HIST1H1D", "H1-3", "H1d", "H1.4", "H14", "HIST1H1E", "H1-4", "H1e", "H1.5", "H15", "HIST1H1B", "H1-5", "H1b"]
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = MESSAGES;
else if (typeof globalThis !== 'undefined') globalThis.MESSAGES = MESSAGES;
