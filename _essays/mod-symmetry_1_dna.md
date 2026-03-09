---
layout: essays
title: 'Broken symmetry (Part 1): Recognizing both strands of the double-helix'
title_short: Recognizing both strands of the double-helix
weight: 2
author: Benjamin Buchmuller
status: Completed
last_modified: 2026-03-07
reads_in: 20 min
excerpt: Strand-asymmetric DNA modifications
---

<div class="essay-summary">
  <p>Symmetry is a key organizing principle in the heredity of epigenetic DNA modifications; but also places where this symmetry breaks can carry information the cell knows how to read.</p>
  <p>Here, I discuss my work on strand-asymmetric cytosine modifications in mammalian genomes, carried out in Daniel Summerer's lab during my PhD.</p>
  <p></p>
  <p class="meta">⏱️ {{ page.reads_in }} read · Updated {{ page.last_modified | date: "%B %d, %Y" }}</p>
</div>

Information can exist wherever entities are neither purely uniformly nor entirely randomly distributed. Biological systems are certainly no exception.
By default, one should be well advised to assume any specific arrangement to be the product of chance—and be surprised when it isn't.

_This essay is part of a series about biologically meaningful deviations from random assortments which, I think, are underappreciated._

## The internal symmetry of CpG dinucleotides

In double-stranded DNA, the dinucleotide CpG is self-complementary:
A CpG on one strand is matched by a CpG on the other.
This gives the site an internal twofold rotational symmetry, making the two strands locally equivalent.
Curiously enough, a group of enzymes, the DNA methyltransferases, maintains this symmetry, transferring a methyl group to both cytosines in the CpG.
The two 5-methylcytosines (5mC) form a strand-symmetric, fully methylated site which can suppress (and occasionally promote) gene expression through various mechanisms.

Nature's epigenetic twist of this symmetric arrangement is that upon DNA replication, each daughter strand inherits a hemi-methylated site which is promptly restored by maintenance DNA methyltransferases.
Thus, the DNA modification pattern and gene activity state is passed along to cellular progeny.
This much is textbook.

Between 2010 and 2015, a series of observations indicated that the modification spectrum of a CpG dyad is richer than "methylated," "hemi-methylated," or "unmethylated."
The ten-eleven translocation (TET) enzymes oxidize 5mC to 5-hydroxymethylcytosine (5hmC), 5-formylcytosine (5fC), and 5-carboxylcytosine (5caC), acting on one strand at a time.
Not only did this suggest a biochemical pathway to revert DNA methylation, but it also implied that **a CpG dyad could carry 5mC on one strand and 5hmC on the other,** or any other symmetric or asymmetric combination of the five possible modification states.

While these asymmetric combinations may not be passed on to cellular progeny in the same way that fully methylated CpG dyads are, some of them might exert regulatory roles in somatic, post-mitotic tissues.
My contributions to this question were to ascertain whether the cell's molecular machinery could tell different combinations apart, and to build probes to investigate these marks in cells.

## Readers of combinatorial CpG modifications

Asymmetric combinations of cytosine modifications present a distinct physical and chemical interface at CpG dinucleotides in the DNA major groove — a unique arrangement of methyl groups, hydroxyl groups, and hydrogen-bond acceptors that a sufficiently selective protein could, in principle, read as a distinct regulatory signal.

### Natural readers discriminate combinatorial CpG modifications

The central readers of symmetric 5mC/5mC dyads in mammals are aptly named "methyl-CpG-binding domain" (MBD) proteins, a family of five human proteins that recruit chromatin remodelers and histone deacetylases to methylated loci.

Through systematic biochemical characterization of the domains, we found that MBDs discriminate across all fifteen possible modification combinations at a single CpG in a family member-dependent manner [(Buchmuller et al., Sci. Rep. 2020)](https://pubmed.ncbi.nlm.nih.gov/32132616).
Four Rett-associated MeCP2 variants did not uniformly weaken binding.
Rather, the mutations seemed to affect how MeCP2 interacted with rarer oxidized configurations while symmetric 5mC/5mC dyads were still bound with the highest affinity, implying that these mutations could change the genomic distribution of MeCP2 without changing where the modified CpGs reside in the genome.

### Engineered readers

Studying these "secondary" binding sites requires tools that are themselves selective for asymmetric marks over the dominant symmetric ones.
A probe based on wild-type MeCP2, or any natural MBD, will be overwhelmed by 5mC/5mC sites whenever deployed on genomic DNA.
What we needed were readers that prefer asymmetric configurations, an unnatural selectivity that, to our knowledge, had no evolutionary precedent.

We addressed this gap through directed evolution, using bacterial cell surface display of degenerate MBDs to select for scaffolds that discriminate against the canonical 5mC/5mC target rather than toward it.
This yielded the first reader capable of discriminating a single 5hmC/5mC CpG dyad against all fourteen other modified configurations, with low nanomolar affinity rivaling the selectivity of wild-type MeCP2 [(Buchmuller et al., JACS 2022)](https://pubmed.ncbi.nlm.nih.gov/35157801).
Biophysical and structural studies indicated the selectivity of the reader hinges on precisely tempered conformational plasticity.
It is flexible enough to accommodate the asymmetric mark, yet rigid enough to reject alternatives [(Singh et al., Nucleic Acids Res. 2023)](https://pubmed.ncbi.nlm.nih.gov/36919612).

We extended the same experimental approach to 5caC/5mC CpG dyads, where the challenge was even steeper since 5-carboxylcytosine differs from the natural MBD substrate in both steric profile and electronics.
Directed evolution nevertheless navigated to readers that fully abandon the conserved methylation-recognition mode in favor of carboxyl-selective contacts [(Kosel et al., Angew. Chem. 2024)](https://pubmed.ncbi.nlm.nih.gov/38284298).

## Distribution of modified CpGs in the mammalian genome

In 2025, a capture and sequencing workflow based on these probes (HM-DyadCap) enabled the first genome-wide map of 5hmC/5mC dyads in mammalian DNA [(Engelhard et al., bioRxiv 2025)](https://doi.org/10.1101/2025.10.29.685270).
While bulk 5hmC had previously been found across both promoters and gene bodies, this specific asymmetric form **accumulates in the bodies of actively transcribed genes** and is depleted at transcription start sites, suggesting that TET oxidizes one strand without immediately completing the conversion on the other to drive both strands toward 5hmC.

Whether that intermediate is specifically oriented with respect to the coding strand, whether it is actively maintained as a regulatory signal, or whether MBD-like readers enforce it is an open question.

### Specific combinations of CpG dyad modifications are non-randomly distributed

We have now seen that one specific dyad configuration—5hmC/5mC—is enriched at gene bodies by using engineered MBDs as affinity probes.
We have also seen that natural readers of fully methylated CpGs are capable of discriminating different oxidation states, and a number of other transcriptional regulators do as well [(Engelhard et al., Adv. Sci. 2026)](https://pubmed.ncbi.nlm.nih.gov/41486423).
Both observations suggest that specific CpG dyad configurations could be involved in regulating gene expression or signal specific gene activity states at certain loci.
Reasoning from first principles, we should expect their prevalence to deviate from what chance would predict.

If both cytosines in the CpG were modified independently, the frequency of each dyad configuration should equal the product of its components' marginal abundances.
In mouse embryonic stem cells, for example, the relative abundances of modified cytosines are well characterized:[^2]
5mC accounts for roughly 73% of CpG cytosines, unmodified C for about 24%, and 5hmC for 3%. 5fC and 5caC are present in trace amounts.

[^2]: Relative cytosine modification levels from [Ito et al. (Science 2011)](https://pubmed.ncbi.nlm.nih.gov/21778364); for comparative studies see [Buchmuller (2021)](https://dx.doi.org/10.17877/DE290R-22422). For simplicity of the argument, all modified cytosines are assumed to occur in a CpG context. A small fraction exists beyond this context.

By chance alone, 5mC/5mC should account for ~54% of CpG dyads and the hemi-methylated C/5mC intermediate for ~35%.
Strand-resolved genome-wide sequencing[^3] shows 5mC/5mC occurs near expectation, while the hemi-methylated state is threefold depleted.
As expected, maintenance methylation erases asymmetry quickly after replication.
The oxidized states deviate even more sharply: C/5hmC accumulates 2.5-fold above chance and is particularly enriched at primed enhancers, while 5mC/5hmC — the configuration HM-DyadCap specifically captures — is twofold less frequent than expected globally, yet concentrates at transcribed gene bodies.

[^3]: [Hardwick et al. (Proc. Natl. Acad. Sci. 2025)](https://pubmed.ncbi.nlm.nih.gov/40743391).

## What we don't know yet

Taken together, these findings establish that strand-asymmetric DNA modifications in CpG dyads are a genuine, if minor, feature of mammalian genomes.
At least two asymmetric forms have distinct genomic distributions and distinct relationships with transcription in mouse embryonic stem cells, a cell state in which 5hmC levels are relatively low, and dominated by replication-dependent hemi-modified configurations.

In terminally differentiated tissue, the picture could be dramatically different.
Nanopore duplex sequencing of mouse cerebellum finds 5hmC/5mC as the overwhelmingly dominant asymmetric form, accounting for 72% of all 5hmC sites versus just 11% for 5hmC/C.[^4]
The probes developed in our work target 5hmC/5mC, making them better suited to precisely probe those differentiated contexts where this form predominates.

Whether the patterns that emerge prove to be a regulatory code or a record of enzymatic kinetics is, I think, one of the more interesting open questions in this corner of chromatin biology.

[^4]: [Halliwell et al. (Commun. Biol. 2025)](https://pubmed.ncbi.nlm.nih.gov/39955446).

<div class="essay-history">
  <p>This is Part 1 of a series on symmetry breaking in biopolymers. In Part 2, we will look at the nucleosome, where the same logic plays out at a different scale.</p>
</div>
