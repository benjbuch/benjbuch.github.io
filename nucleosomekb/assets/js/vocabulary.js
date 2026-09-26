// GENERATED — do not edit. Edit registry/vocabulary.yaml (names) or registry/organisms.tsv
// (species order) instead.

const PTM_NAMES = {
  me: 'methylation (degree unstated)',
  me1: 'monomethylation',
  me2: 'dimethylation',
  me3: 'trimethylation',
  me2a: 'dimethylation (asymmetric)',
  me2s: 'dimethylation (symmetric)',
  ac: 'acetylation',
  bhb: 'beta-hydroxybutyrylation',
  bu: 'butyrylation',
  cr: 'crotonylation',
  hib: '2-hydroxyisobutyrylation',
  hxo: 'hexanoylation',
  la: 'lactylation',
  mal: 'malonylation',
  pro: 'propionylation',
  su: 'succinylation',
  vl: 'valerylation',
  ph: 'phosphorylation',
  ub: 'ubiquitination',
  ub1: 'mono-ubiquitination, intact conjugate',
  ubn: 'poly-ubiquitination',
  sumo: 'sumoylation',
  nedd: 'neddylation',
  dop: 'dopaminylation',
  his: 'histaminylation',
  ser: 'serotonylation',
  GlcNAc: 'O-GlcNAcylation',
  ar: 'ADP-ribosylation',
  ar1: 'mono-ADP-ribosylation',
  arn: 'poly-ADP-ribosylation',
  gly: 'glycation',
  cml: 'carboxymethyl-lysine',
  cel: 'carboxyethyl-lysine',
  cit: 'citrullination',
  mp: '5-methylene-2-pyrrolone'
};

// The chemistry shelf each mark is displayed under. Display sectioning only — nothing in
// the lattice reads it. See the `class:` comment in registry/vocabulary.yaml.
const PTM_CLASS = {
  'me': 'methylation',
  'me1': 'methylation',
  'me2': 'methylation',
  'me3': 'methylation',
  'me2a': 'methylation',
  'me2s': 'methylation',
  'ac': 'acylation',
  'bhb': 'acylation',
  'bu': 'acylation',
  'cr': 'acylation',
  'hib': 'acylation',
  'hxo': 'acylation',
  'la': 'acylation',
  'mal': 'acylation',
  'pro': 'acylation',
  'su': 'acylation',
  'vl': 'acylation',
  'ph': 'phosphorylation',
  'ub': 'ubiquitin-like',
  'ub1': 'ubiquitin-like',
  'ubn': 'ubiquitin-like',
  'sumo': 'ubiquitin-like',
  'nedd': 'ubiquitin-like',
  'dop': 'monoaminylation',
  'his': 'monoaminylation',
  'ser': 'monoaminylation',
  'GlcNAc': 'glycosylation',
  'ar': 'ADP-ribosylation',
  'ar1': 'ADP-ribosylation',
  'arn': 'ADP-ribosylation',
  'gly': 'glycation',
  'cml': 'glycation',
  'cel': 'glycation',
  'cit': 'other',
  'mp': 'other'
};

// Set MEMBERSHIP, which IS load-bearing: `me` is the set, me1/me2/me3 are its members.
// A singleton PTM is its own group.
const PTM_GROUP = {
  'me': 'me',
  'me1': 'me',
  'me2': 'me',
  'me3': 'me',
  'me2a': 'me',
  'me2s': 'me',
  'ac': 'ac',
  'bhb': 'bhb',
  'bu': 'bu',
  'cr': 'cr',
  'hib': 'hib',
  'hxo': 'hxo',
  'la': 'la',
  'mal': 'mal',
  'pro': 'pro',
  'su': 'su',
  'vl': 'vl',
  'ph': 'ph',
  'ub': 'ub',
  'ub1': 'ub1',
  'ubn': 'ubn',
  'sumo': 'sumo',
  'nedd': 'nedd',
  'dop': 'dop',
  'his': 'his',
  'ser': 'ser',
  'GlcNAc': 'GlcNAc',
  'ar': 'ar',
  'ar1': 'ar1',
  'arn': 'arn',
  'gly': 'gly',
  'cml': 'gly',
  'cel': 'gly',
  'cit': 'cit',
  'mp': 'mp'
};

// The shelves the mark palette shows, IN ORDER, with their authored wording. Display only.
const PTM_CLASS_ORDER = [
  { id: 'methylation', label: 'Methylation' },
  { id: 'acylation', label: 'Acylation' },
  { id: 'phosphorylation', label: 'Phosphorylation' },
  { id: 'ubiquitin-like', label: 'Ubiquitin-like' },
  { id: 'monoaminylation', label: 'Monoaminylation' },
  { id: 'glycosylation', label: 'Glycosylation' },
  { id: 'ADP-ribosylation', label: 'ADP-ribosylation' },
  { id: 'glycation', label: 'Glycation' },
  { id: 'other', label: 'Other' }
];

// The residues a mark can legitimately sit on. Side-chain chemistry; the α-amino site is
// a separate axis (`alpha:` in the YAML) and is not emitted here.
const PTM_RESIDUES = {
  'me': ['K', 'R'],
  'me1': ['K', 'R'],
  'me2': ['K'],
  'me3': ['K'],
  'me2a': ['R'],
  'me2s': ['R'],
  'ac': ['K'],
  'bhb': ['K'],
  'bu': ['K'],
  'cr': ['K'],
  'hib': ['K'],
  'hxo': ['K'],
  'la': ['K'],
  'mal': ['K'],
  'pro': ['K'],
  'su': ['K'],
  'vl': ['K'],
  'ph': ['S', 'T', 'Y'],
  'ub': ['K'],
  'ub1': ['K'],
  'ubn': ['K'],
  'sumo': ['K'],
  'nedd': ['K'],
  'dop': ['Q'],
  'his': ['Q'],
  'ser': ['Q'],
  'GlcNAc': ['S', 'T'],
  'ar': ['S', 'R', 'E', 'D', 'K', 'C'],
  'ar1': ['S', 'R', 'E', 'D', 'K', 'C'],
  'arn': ['S', 'R', 'E', 'D', 'K', 'C'],
  'gly': ['K'],
  'cml': ['K'],
  'cel': ['K'],
  'cit': ['R'],
  'mp': ['K']
};

// Everything the notation can SUBSTITUTE that is not one of the standard 20, in file order.
// `kind` is derived from the residue's own fields - see the generator.
const NONCANONICAL_RESIDUES = [
  { token: 'U', name: "selenocysteine", kind: 'recoded' },
  { token: 'O', name: "pyrrolysine", kind: 'recoded' },
  { token: 'Nle', name: "norleucine", kind: 'synthetic' },
  { token: 'Ecx', name: "S-ethyl-L-cysteine", kind: 'synthetic' },
  { token: 'B', name: "Asx (aspartate or asparagine)", kind: 'ambiguity codes' },
  { token: 'Z', name: "Glx (glutamate or glutamine)", kind: 'ambiguity codes' },
  { token: 'J', name: "Xle (leucine or isoleucine)", kind: 'ambiguity codes' },
  { token: 'X', name: "any standard residue", kind: 'ambiguity codes' }
];

// The order the organisms go in, everywhere. Row order of registry/organisms.tsv.
const TAXON_ORDER = [9606, 10090, 8355, 7227, 6239, 4932, 4896];
