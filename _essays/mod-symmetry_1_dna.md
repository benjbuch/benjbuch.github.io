---
layout: essays
title: 'Broken symmetry (Part 1): Recognizing both strands of the double-helix'
weight: 2
author: Benjamin Buchmuller
status: Completed
last_modified: 2026-03-07
reads_in: 20 min
excerpt: Strand-asymmetric DNA modifications
---

<div class="essay-summary">
  <p>Symmetry is a key organizing principle in the hereditary of epigenetic DNA modifications; but also places where symmetry breaks carry information the cell knows how to read. Here, I discuss my PhD work on strand-asymmetric cytosine modifications in mammalian genomes.</p>
  <p class="meta">⏱️ {{ page.reads_in }} read · Updated {{ page.last_modified | date: "%B %d, %Y" }}</p>
</div>

Information can exist wherever entities are neither purely uniformly nor entirely randomly distributed. Biological systems are certainly no exception. 
So, by default, one should be well advised to assume any specific arrangement to be the product of chance—and to be surprised when it isn't.

This essay is part of a series about biologically meaningful deviations from random assortments which, I think, are underappreciated.
We start in the realm of epigenetic DNA modifications.

## Dinucleotide modifications with an internal symmetry axis

In double-stranded DNA, the dinucleotide CpG is self-complementary:
A CpG on one strand is matched by a CpG on the other.
This gives the site an internal twofold rotational symmetry, making the two strands, in principle, locally equivalent.
Curiously enough, a group of enzymes, the DNA methyltransferases, respects this symmetry, installing 5-methylcytosine (5mC) on both cytosines to produce a strand-symmetric, fully methylated site.
After DNA replication, each daughter strand inherits a hemi-methylated site, which is promptly restored by maintenance DNA methyltransferases.
The modification pattern is passed along to cellular progeny.
This much is textbook.

Between 2010 and 2015 a series of observations indicated that the modification spectrum of a CpG dyad is richer than "methylated," "hemi-methylated," or "unmethylated."
The ten-eleven translocation (TET) enzymes oxidize 5mC to 5-hydroxymethylcytosine (5hmC), 5-formylcytosine (5fC), and 5-carboxylcytosine (5caC), acting on one strand at a time.
A CpG dyad can therefore carry 5mC on one strand and 5hmC on the other, or any other symmetric or asymmetric combination of the five possible modification states.

A natural question (at least for the premise of this essay series) is whether these configurations arise by chance or are actively coordinated.
In mouse embryonic stem cells, the relative abundances of modified cytosines are well characterized:[^1]
5mC accounts for roughly 73% of CpG cytosines, unmodified C for about 24%, and 5hmC for 3%. 5fC and 5caC are present trace amounts.
So, if the two strands were modified independently, the frequency of each dyad configuration should equal the product of its components' marginal abundances. 
Recently, the actual genome-wide frequencies were measured by next-generation sequencing,[^2] so we can test their distribution against our hypothesis that the process is random:

[^1]: Relative cytosine modification levels from Ito et al. (Science, 2011). For simplicity of the argument, all modified cytosines are assumed to occur in a CpG context. A small fraction exists beyond this context.

[^2]: Hardwick et al. (Proc. Nat. Acad. Sci., 2025).

| Combination          | Expected | Observed | log2(O/E) |
|----------------------|----------|----------|-----------|
| 5mC/5mC              |    53.6% |    59.8% |     +0.16 |
| C/C                  |     5.6% |    21.6% |     +1.94 |
| 5hmC/5hmC            |    0.09% |     0.1% |     +0.15 |
| C/5mC or 5mC/C       |    34.6% |    12.7% |     -1.44 |
| C/5hmC or 5hmC/C     |     1.4% |     3.6% |     +1.36 |
| 5mC/5hmC or 5hmC/5mC |     4.4% |     2.0% |     -1.14 |

For DNA methylation, the pattern is close to textbook.
The symmetric states dominate, and the hemi-methylated intermediate is depleted roughly threefold, consistent with maintenance methylation resolving asymmetry rapidly after replication.
The oxidized states are more interesting.
C/5hmC is enriched more than twofold over random expectation, perhaps a consequence of inheriting hemi-hydroxymethlated sites, while 5mC/5hmC are depleted, suggesting that TET-mediated oxidation does not simply act on whichever strand it encounters first, or that the two configurations are not biochemically equivalent once formed.

## Readers of DNA methylation are oriented molecules

If these configurations arise non-randomly, the question becomes whether the cell's molecular machinery can actually tell them apart.
The classical readers of symmetric 5mC/5mC dyads are the methyl-CpG-binding domain (MBD) proteins, a family of five human proteins that recruit chromatin remodelers and histone deacetylases to methylated loci.
We asked whether MBDs can discriminate across all fifteen possible modification combinations at a single CpG.

In fact they do, in a family member-dependent manner and with altered specificities that may have functional consequences (Buchmuller et al., Sci. Rep. 2020).
The most clinically telling case is MeCP2, which is mutated in Rett syndrome, a severe neurological disorder.
When we profiled four Rett-associated MeCP2 variants, the mutations did not uniformly weaken methyl-CpG binding.
Instead, each mutant reshaped the protein's preferences among oxidized dyad combinations differently.
A single point mutation could make MeCP2 favor a different set of epigenetic states without altering where methylated CpGs exist in the genome.
So, the epigenetic landscape may look different depending on who is reading it, and different again when the reader is broken.

If specific dyad states carry distinct regulatory information, studying them requires tools that detect each configuration selectively.
No such tools existed.
We resorted to directed evolution to evolve MBDs into affinity probes for asymmetric marks.
The result was the first reader capable of discriminating a single 5hmC/5mC CpG against all fourteen other modified configurations, with low nanomolar affinity rivaling the selectivity of wild-type MeCP2 (Buchmuller et al., JACS 2022).
The engineered reader achieves specificity through precisely tempered conformational plasticity.
It is flexible enough to accommodate the asymmetric mark, yet rigid enough to reject alternatives (Singh et al., Nucleic Acids Res. 2023).
We extended the same design logic to 5caC/5mC dyads, where the challenge was steeper since 5-carboxylcytosine differs from the natural MBD substrate in both steric profile and electronics.
Gratifyingly, directed evolution also navigated to readers that completely abandon the conserved methylation-recognition mode in favor of carboxyl-selective contacts (Kosel et al., Angew. Chem. 2024).

Recently, my colleagues deployed these probes in HM-DyadCap to capture and sequencing the first genome-wide map of 5hmC/5mC dyads in mammalian DNA (Engelhard et al., bioRxiv 2025).
We find these sites mostly in actively transcribed gene bodies and absent from transcription start sites.

## What we don't know yet

Recent studies provide a growing body of evidence that asymmetric modifications in CpG dyads are rare, but certainly not random artifacts in mammalian genomes.
But these measurements come from mouse embryonic stem cells, where 5hmC levels are modest.
In human brain, 5hmC is substantially more abundant, and the landscape of asymmetric states could look quite different.
More importantly, no current method allows us to interrogate the functional consequences of specific dyad states in living cells.
We can detect them, we can show that readers discriminate them, but whether they instruct distinct transcriptional outcomes remains an open question.

I suspect the answer will depend on cell type, genomic context, and which readers are expressed—making this less a single discovery waiting to be made than a layer of regulation waiting to be mapped.
The tools exist to start. The maps are being drawn. What they mean is the next question.

<div class="essay-history">
  <p>This is Part 1 of a series on symmetry breaking in biopolymers. In Part 2 we will look at the nucleosome, where the same logic plays out at a different scale.</p>
</div>
