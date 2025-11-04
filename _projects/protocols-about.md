---
layout: projects
title: Protocols that know their own history
weight: 1
excerpt: How lab protocols can be tracked, built, and published in print and online
---

## The Problem at the Bench

Picture this: You're at the bench with a printed protocol from your colleague. There are handwritten notes in the margins which could be theirs, or maybe someone else's from three years ago. A concentration is crossed out and rewritten. A step number is circled with "skip this?" scrawled next to it. The printout is coffee-stained and dog-eared, so you're not sure if it's the current version or one from two revisions ago.

Lab protocols live in a messy world. They get passed around as Word files like `Protocol_final_v3_ACTUAL_final.docx`, they're photocopied from papers, excerpted from lab notebooks, or typed up quickly and never quite finished. Critical details get buried in email threads. Authorship becomes murky. And when methods evolve (as they always do), you end up with a dozen conflicting variants floating around.

I got tired of that chaos.

## Why I Built This

Honestly? It started as a typesetting exercise. In Word, making a protocol look good takes forever. You wrestle with formatting, adjust margins, fiddle with indentation, and then, inevitably, you decide to change the layout six months later and have to do it all over again. What do you even do with the old versions? Archive them in a folder called `old_protocols`? Hope for the best?

I wanted to see if I could build something cleaner, something that separated content from presentation in a meaningful way. That way, I could **focus on *what* a protocol says, not *how* it looks**. And if I ever wanted to change the design, I could update the template once and regenerate everything.

That separation also meant version control could work the way it does for code. Instead of tracking binary Word files, I could track plain text XML. Git would **show me exactly what changed, line by line**. No more guessing whether step 7 was different in the last version.

It also opened up **possibilities for extracting data from the "codebase."** Want all your recipes in one document? Extract them. Want a bullet-point summary of a protocol? Generate it. The structure is there; you just need to render it differently. (I haven't built all of this yet, but the foundation is there. Someone cover my salary for two months and I'll work on it full-time. Half-joking.)

The ideal tool for this was ConTeXt, a general-purpose document processor similar to LaTeX. It can process XML directly and generate beautiful PDFs, which is great because people still print protocols to take to the bench. I certainly do. And XML can be converted to HTML, too, so web-based rendering is on the horizon. Someday.

## What I Learned Along the Way

### Designing a vocabulary

The first challenge was creating an XML schema that made sense. What's a protocol, really? It has steps for sure, but also metadata, recipes, safety information, troubleshooting advice, references. How do you structure all of that in a way that's flexible but consistent?

I started documenting the vocabulary as I went. That turned out to be one of the best decisions I made. Although I intended that piece of documentation just being for "future me," it turned out very useful for instructing LLMs to **validate syntax** or **reformat** old Word documents into the new XML structure.

### Versioning printed protocols

I also had to figure out how to track whether a printed copy was still current. DOIs didn't feel right as they're too heavyweight and formal for a personal protocol collection. So, I borrowed from semantic versioning:

- **Typos or trivial fixes** just get a Git commit. Let's still call it "up to date" because nothing meaningful changed.
- **Additions or clarifications** are reflected in a changelog entry like "Added section on troubleshooting low yields." and that's when we start reporting a newer protocol version is available, similar to a minor bump.
- **Major rewrites** get a new major version (e.g., `protocol-v2.xml`). Unlike starting fresh with a new document, the changelog preserves the reasoning and evolution.

It's not a perfect system, but it's practical. And that's what matters.

### The discipline of structure

One unexpected benefit is that writing protocols in structured XML forces you to be clearer. You can't just throw a vague note into the middle of a step; you have to decide: Is this an action? A note of caution? A troubleshooting advice? That discipline **improves the clarity of the protocol** itself.

Changelogs have the same effect. Knowing you'll document what changed makes you more thoughtful about edits. It's not just fix-and-forget anymore.

And because recipes are modular, updating a buffer composition in one place propagates to all documents that use it. **No more hunting through a dozen files** to change a concentration.

## The Tradeoffs

I'd be lying if I said this approach was easy or universally applicable. This approach requires more upfront work than opening Word and typing. You need to be comfortable with text editors, version control, and a bit of command-line work. The toolchain (ConTeXt, Lua, Git) has a learning curve and if a colleague doesn't want to learn XML, they might be less likely to contribute. Maybe automation will lower the bar.

Currently, this is a personal system that works for me, and I'm not claiming it's the right solution for everyone. However, for the problems I wanted to solve (clarity, reproducibility, version tracking, and modularity) it works.

## What's Next: The Field Trip

Right now, I'm sharing a small, personal collection. I use these protocols. I revise them. I track their history. But I'm curious whether others too find value in this work. If you're working in a related field, try one. If you're technically curious, check out how it's built. If you spot an error or have feedback, let me know.

Maybe this will resonate with someone else who's tired of `Protocol_final_v3_ACTUAL_final.docx`. Maybe it won't. Either way, it's been a useful exercise and **the protocols look damn good**. :-)
