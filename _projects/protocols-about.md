---
layout: projects
title: Protocols that know their own history
weight: 1
author: Benjamin Buchmuller
minutes: 8 min
last_modified_at: 2026-02-20
excerpt: How lab protocols can be tracked, built, and published in print and online
---

<div class="project-summary">
  <p>Many protocol collections share the same fate. They become coffee-stained printouts or end up in a folder called "old protocols". This project is an attempt to do better with version-controlled documents that keep their own history.</p>
  <ul>
    <li>Version-controlled SOPs with full changelog</li>
    <li>XML source rendered to PDF and HTML</li>
    <li>Online version checker for printed copies</li>
  </ul>
   <p class="meta">⏱️ {{ page.minutes }} read · Updated {{ page.last_modified_at | date: "%B %d, %Y" }}</p>
</div>

#### ___A: You've built a version-controlled protocol system for the lab bench. Tell us more about the problem you wanted to solve.___

___B:___ Picture this: You're at the bench with a printed protocol from your colleague. There are handwritten notes in the margins which could be theirs, or maybe someone else's from three years ago. A concentration is crossed out and rewritten. A step number is circled with "skip this?" scrawled next to it ...

#### ___A: — and I know this scene. The printout is coffee-stained and dog-eared, you're not sure if it's the current version or one from two revisions ago.___

___B:___ Exactly. Lab protocols live in a messy world. They get passed around as Word files like "Protocol_final_v3_ACTUAL_final.docx" while some critical details may still be buried in email threads. After a while, when methods evolve, as they always do, you end up with a dozen conflicting variants floating around. I got tired of that chaos.

####  ___A: So you typed your own stack of protocols to get lost?!___

___B:___ Not quite. 

#### ___A: I always wondered why  people retype protocols in the first place? From what I can tell, it's usually because the original file doesn't exist anymore, or because nobody can stand looking at whatever came out of a 1960s typewriter or a table that Word generated in 2003.___

___B:___ That's unfortunately often true. There are two traps really: one is losing the source document, the other is entangling content and form from the start. In Word, the *what it says* and the *how it looks* are fused together. You can't touch the layout essentially without saving a new copy of the file —

#### ___A: — and what do people even do with all those versions? Archive them in a folder called "old protocols" and hope for the best?___

___B:___ Yeah. I wanted to see if I could build something cleaner. What's a protocol, really? It has steps, recipes, safety information, troubleshooting advice, references. Once you separate that content from its representation in a consistent and meaningful way, authors can *focus on what a protocol says, not how it looks.*

#### ___A: Your protocols do look damn good. What tool did you use?___

___B:___ I used ConTeXt, a general-purpose document processor similar to LaTeX. It works on the principle of a markup language. The author only needs to identify the *role* of each element. Is this a step? A caution? A recipe? The interpreter handles all the formatting. If you ever want to change the formatting, you update the template in one place and regenerate all published output on the fly. 

Since the source can be XML files in ConTeXt, one can use the same document to generate beautiful PDFs for the bench *and* convert them into HTML for the web.

That separation also means version control can work the way it does for code. Instead of backing up binary Word files, one can track changes to the XML documents. Git, a free version-control system, will *show exactly what changed, line by line.* No more guessing whether step 7 was different in the last version.

#### ___A: Sounds like your approach is on a par with the development of the printing press.___

___B:___ In terms of "amplifying" information, it kind of is. With markup documents you have endless *possibilities for extracting data from the "codebase."* Want all your recipes in one document? Extract them. Want a bullet-point summary of a protocol? Generate it. The structure is there, you just need to render it differently. 

And because recipes are modular, updating a buffer composition in one place can propagate to all documents that reference that information. *No more hunting through a dozen files* to change a concentration.

#### ___A: You made all of this already?___

___B:___ I haven't built all of this yet, but the foundation is there. While the PDF protocols and recipe book are available online, I'd be thrilled about an interactive HTML version of them. Someday, or if someone covered my salary for two months, I'll work on it full-time.

#### ___A: So, this is much more involved than it sounds?___

___B:___ I'd be lying if I said this approach was easy or universally applicable. It requires more upfront work than opening Word and typing. You need to be comfortable with text editors, version control, and a bit of command-line work. The toolchain (ConTeXt, Lua, Git) has a learning curve. And if a colleague doesn't want to memorize the XML semantics, they might be less likely to contribute. 

I'm confident that machine learning will lower that bar. I started documenting the vocabulary as I went which turned out to be one of the best decisions I made. Although I intended that piece of documentation just for "future me," I could already use it for instructing LLMs to *validate syntax* or *reformat* old Word documents into the new XML structure.

#### ___A: Will there be a surge in protocol releases soon?___

___B:___ Let's say the barrier to entry just got lower.

#### ___A: Going back to the bench, people still print protocols. How can they make sure their version is up to date?___

___B:___ Everyone carries a smartphone. Taking a picture is quick. So, what if you could just scan a QR code on the printout to check whether you have the latest version?

#### ___A: — Like digital menus in a restaurant.___

___B:___ Yes. You scan the QR code and get the chef's latest innovations and the price for tonight's dinner. However, our version checker is much more transparent. It provides a summary of the changes between the document at hand and the most recent version, so the user can decide whether they need or want to try out the newest protocol or not.

#### ___A: I noticed the QR code only encodes a short hash. Isn't that fragile? Surely you could have a proper DOI instead?___

___B:___ Digital object identifiers (DOIs) are designed for discrete releases, something complete enough to cite in a paper. But a protocol that gets a typo fixed at 11&nbsp;p.m. doesn't need a new DOI, it just needs a commit. The overhead of formal registration would actually discourage exactly the kind of small, frequent updates that make this system useful. And practically speaking, the 7-digit hash works anywhere the QR code doesn't, scribbled in a notebook, dropped in an email.

#### ___A: What counts as a new version?___

___B:___ I borrowed from semantic versioning:

- *Typos or trivial fixes* just get a Git commit. We still call it "up to date" as nothing meaningful changed.
- *Additions or clarifications* are reflected in an additional changelog entry such as, "Added advice on troubleshooting low yields." That's when we start reporting that a newer protocol is available, similar to a minor version bump.
- *Major rewrites* get a new major version. We actually change the file name "protocol-v2.xml", so people unfamiliar with Git can still find version&nbsp;1 if needed. However, unlike starting fresh with a new document, the changelog preserves the reasoning and evolution.

It's not a perfect system, but it's practical. And that's what matters.

#### ___A: Did setting up this structure teach you anything about protocol writing?___

___B:___ One unexpected benefit is that writing protocols in structured XML forces you to be clearer. You can't just throw a vague note into the middle of a step; you have to decide what it's for. Is this an action? A note of caution? A piece of troubleshooting advice? That discipline *improves the clarity of the protocol* itself.

#### ___A: Very philosophical! Can anyone contribute?___

___B:___ I believe that everyone in a lab should be able to contribute and get credit for their work in the version history. However, having a handful of curators (or editors) who regularly incorporate changes, may improve consistency. Knowing you'll document what changed makes you more thoughtful about edits. It's not just fix-and-forget anymore.

#### ___A: Is this a project for the world or just for you?___

___B:___ Currently, this is a personal system that works for me, and I'm not claiming it's the right solution for everyone. But for the problems I wanted to solve — clarity, reproducibility, version tracking, modularity — it works.

#### ___A: What's next?___

___B:___ Right now, I've started sharing my small personal collection. I use these protocols. I revise them. I track their history. But I'm curious whether others find value in this work too. So, if you're working in a related field, try one. If you're technically curious, check out how it's built. If you spot an error or have feedback, let me know. Maybe this will resonate with someone who's tired of "Protocol_final_v3_ACTUAL_final.docx." Maybe it won't.

#### ___A: I shall look forward to scanning the QR code on my next printed protocol then. Assuming, I can find it under the coffee stains.___

<div class="project-history">
  <p>The original post was rewritten as fictional interview in 2026. While the project is real, any resemblance to actual interviews is purely coincidental.</p>
</div>
