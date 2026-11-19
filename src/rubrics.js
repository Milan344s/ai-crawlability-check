// Scoring rubrics returned to the calling model. The caller's own model does
// the judging, so this server never needs an LLM key.

const HOUSE_RULES = `House rules for every review:
- Quote the exact line you are judging. Score what the copy does, not what it could do.
- Never invent a number, source, customer or credential to make a rewrite stronger. Write [X] and say what is missing.
- Be blunt. A weak draft gets a low score.
- Give the 3 fixes that move the score most, each as Before -> After.`;

export const RUBRICS = {
  geo: {
    title: "AI citability (GEO) rubric",
    use_for: "Judging whether an LLM would quote a page or article as a source. Run check_ai_citability first for the measurable half; this rubric covers what needs a read.",
    text: `# AI citability rubric

SEO earns a ranking. Citability earns a quote inside a generated answer. Score each item PASS / FAIL / FLAG with the quoted line and a fix.

1. Answer first. One self-contained sentence in the first 2 to 3 lines defines the topic and answers the core query ("[Topic] is ..."). Every major section also opens with its most quotable claim.
2. Question and answer shape. H2/H3 headings are questions where natural. The first sentence under each heading answers it and repeats the heading's entity ("What is X?" -> "X is ...", never "It's an approach that ...").
3. Definitive language. Definitions use is / means / is defined as. Under 30 words, no pronoun pointing at an earlier paragraph. No hedges: essentially, basically, arguably, may help, could potentially.
4. Named entities. Brands, tools, people, versions, years and standards are named. Flag any stretch of several paragraphs with no name or number.
5. Consistent naming. One official spelling per brand and product. People named in full with role on first mention. Acronyms expanded once per major section.
6. Explicit subjects. No pronoun carried across a sentence boundary without restating the subject. Claims about a third party name that party in the same sentence.
7. Analytical tone. Fact -> context -> interpretation. No press-release hype (game-changing, revolutionary, best-in-class). Every major claim has a reason, a consequence or a trade-off.
8. Plain sentences. Rarely over 25 words; subject-verb-object; filler cut ("in order to", "it is important to note").
9. Answer-shaped formatting. Paragraphs of 2 to 4 lines, each readable alone. A numbered list for any process. A real table for any comparison.
10. Density. Every paragraph holds at least one fact, number, entity or conclusion. Something the top-ranking pages do not have: own data, first-hand experience, a clear position.
11. Statistics. Number, year and source in the same sentence. Flag stats older than 24 months.
12. FAQ. 4 to 8 real user questions, each answered directly in the first sentence, 1 to 3 sentences long.
13. Schema (recommend, do not fail): Article with author and dates, FAQPage, HowTo, Person with sameAs, Organization.

Deduct for: sentences over 30 words that bury the claim, ambiguous "this approach / the solution", sentences with no factual content, unattributed quotes.

Output:
## AI citability review
- [PASS|FAIL|FLAG] item: quoted line. Fix: ...
Summary: N of 13 passed. Top 3 fixes as Before -> After. Schema to add.`,
  },

  seo: {
    title: "Pre-publish SEO rubric",
    use_for: "The judgment half of an on-page SEO review. Run check_seo_basics first for lengths, headings, links and keyword counts.",
    text: `# Pre-publish SEO rubric

Score each item PASS / FAIL / FLAG with a one-line reason and a fix.

Intent and structure
1. Format matches the dominant search intent: informational -> guide or definition; commercial investigation -> comparison; transactional -> list or alternatives page. A mismatch is a FAIL and a writer decision.
2. The main query is answered at the very start of the body, before history or scene-setting.
3. A TL;DR or summary sits on the first screen. Lists and comparisons put the comparison table in the first 20 to 30% of the page.

Title, description, slug
4. Title: 50 to 60 characters, keyword in the first 30. Listicles use [number] + [type of thing] + [year].
5. Meta description: 140 to 160 characters, contains the keyword, gives a reason to click that the title did not.
6. Slug: short, contains the keyword, no stop-words; year included for time-sensitive pages.

Headings and keywords
7. One H1 of 60 characters or fewer with the keyword. No skipped levels.
8. No bare-label H3s ("Pricing", "Features"). At least half of H2/H3 are natural questions.
9. Keyword in the first 100 words, density 0.5 to 1.5%, spread across sections, with semantic variants. Read it aloud: audible repetition is stuffing.

Depth and trust (flag what is missing; never fabricate)
10. Depth meets the pages already ranking and adds one angle they lack.
11. Named author with a bio link.
12. Experience signal: a real example, number or screenshot from the author's own work. This is the one thing a competitor cannot copy.
13. Expertise signal: credential, named expert quote or stated track record.
14. Every statistic links to the original publisher, not a blog quoting a blog. Authorities are named in the text, not only in the link.
15. Every claim about a third-party product has a linked source.

Links and media
16. 2 to 5 internal links with descriptive anchors, no duplicates, page connected to its topic cluster.
17. External links to authoritative sources; no bare URLs in prose.
18. Images: descriptive filename and alt text, placed beside the section they illustrate.

Final
19. Last-updated date is current. No information lives only inside a widget or embed.
20. Schema: Article or BlogPosting; FAQPage and HowTo where they apply.

Output:
## SEO review
- [PASS|FAIL|FLAG] item: reason. Fix: ...
Summary: N of 20 passed. Top 3 fixes. Proposed title, meta description and slug.`,
  },
};

export function rubricPayload(type) {
  const r = RUBRICS[type];
  if (!r) throw new Error(`Unknown rubric "${type}". Use one of: ${Object.keys(RUBRICS).join(", ")}.`);
  return { rubric: type, title: r.title, use_for: r.use_for, instructions: `${HOUSE_RULES}\n\n${r.text}` };
}
